import { z } from "zod/v4";
import { DossierError } from "./contracts";
import { boundedBytes, sha256 } from "./downloads";
import {
  normalizeExtraction,
  type ExtractionFile,
  type ExtractionResult,
  type OcrServiceBinding,
} from "./extraction";
export interface OcrCheckpointStore {
  load(): Promise<unknown | null>;
  save(value: unknown): Promise<void>;
}
const pageSchema = z.object({
  page: z.number().int().positive(),
  text: z.string().max(2_000_000),
});
const stateSchema = z.object({
  version: z.literal(1),
  sourceHash: z.string(),
  parserVersion: z.string().min(1).max(100),
  pageCount: z.number().int().min(1).max(10000),
  pages: z.array(pageSchema).max(10000),
  warnings: z.array(z.string().max(500)).max(100),
});
type OcrState = z.infer<typeof stateSchema>;
function validatePages(pages: OcrState["pages"], first: number) {
  if (pages.some((p, i) => p.page !== first + i))
    throw new DossierError("OCR_BATCH_INVALID", 409);
  if (pages.reduce((n, p) => n + p.text.length, 0) > 8_000_000)
    throw new DossierError("EXTRACTION_TOO_LARGE", 413);
}
export async function loadOcrCheckpoint(
  file: ExtractionFile,
  store: OcrCheckpointStore,
): Promise<OcrState | null> {
  const raw = await store.load();
  if (raw === null) return null;
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new DossierError("OCR_CHECKPOINT_INVALID", 409);
  const state = parsed.data;
  if (state.sourceHash !== (await sha256(file.bytes))) return null;
  validatePages(state.pages, 1);
  if (state.pages.length > state.pageCount)
    throw new DossierError("OCR_CHECKPOINT_INVALID", 409);
  return state;
}
function finish(state: OcrState): ExtractionResult {
  return normalizeExtraction({
    parserVersion: state.parserVersion,
    pages: state.pages,
    warnings: [...new Set([...state.warnings, "OCR_TEXT_REQUIRES_REVIEW"])],
    complete: true,
  });
}
export async function extractOcrPageBatch(
  file: ExtractionFile,
  signal: AbortSignal,
  service: OcrServiceBinding,
  store: OcrCheckpointStore,
  state: OcrState | null,
): Promise<ExtractionResult> {
  if (state && state.pages.length === state.pageCount) return finish(state);
  signal.throwIfAborted();
  if (file.bytes.length > 25 * 1024 * 1024)
    throw new DossierError("OCR_FILE_LIMIT", 413);
  const start = (state?.pages.length ?? 0) + 1;
  const response = await service.fetch(
    new Request("https://ocr.internal/v1/extract", {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-ocr-start-page": String(start),
        "x-ocr-page-count": "5",
      },
      body: Uint8Array.from(file.bytes).buffer,
      signal,
    }),
  );
  const raw = JSON.parse(
    new TextDecoder().decode(await boundedBytes(response, 10 * 1024 * 1024)),
  );
  if (!response.ok) {
    const known = [
      "OCR_TIMEOUT",
      "OCR_PAGE_LIMIT",
      "OCR_FILE_LIMIT",
      "OCR_INVALID_PDF",
      "OCR_ENCRYPTED_PDF",
      "OCR_INVALID_PAGE_RANGE",
    ];
    if (known.includes(raw.error)) throw new DossierError(raw.error, 409);
    throw new DossierError(
      response.status === 429 ? "OCR_BUSY" : "OCR_UNAVAILABLE",
      503,
      response.status === 429 || response.status >= 500,
    );
  }
  const batchSchema = stateSchema
    .omit({ version: true, sourceHash: true })
    .extend({
      startPage: z.number().int().positive(),
      endPage: z.number().int().positive(),
      nextPage: z.number().int().positive().nullable(),
      complete: z.boolean(),
    });
  const parsed = batchSchema.safeParse(raw);
  if (!parsed.success) throw new DossierError("OCR_BATCH_INVALID", 409);
  const batch = parsed.data;
  const end = Math.min(batch.pageCount, start + 4);
  if (
    batch.startPage !== start ||
    batch.endPage !== end ||
    batch.pages.length !== end - start + 1 ||
    batch.nextPage !== (end === batch.pageCount ? null : end + 1) ||
    batch.complete !== (end === batch.pageCount) ||
    (state &&
      (batch.pageCount !== state.pageCount ||
        batch.parserVersion !== state.parserVersion))
  )
    throw new DossierError("OCR_BATCH_INVALID", 409);
  validatePages(batch.pages, start);
  const merged: OcrState = {
    version: 1,
    sourceHash: state?.sourceHash ?? (await sha256(file.bytes)),
    parserVersion: batch.parserVersion,
    pageCount: batch.pageCount,
    pages: [...(state?.pages ?? []), ...batch.pages],
    warnings: [
      ...new Set([...(state?.warnings ?? []), ...batch.warnings]),
    ].slice(0, 100),
  };
  validatePages(merged.pages, 1);
  await store.save(merged);
  if (merged.pages.length !== merged.pageCount)
    throw new DossierError("OCR_CONTINUING", 202, true);
  return finish(merged);
}
