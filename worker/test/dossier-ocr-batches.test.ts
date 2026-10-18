import { describe, it, expect } from "vitest";
import {
  CpuOcrFallbackProvider,
  type ExtractionResult,
} from "../src/dossier/extraction";
import { DossierError } from "../src/dossier/contracts";
const file = {
  name: "long.pdf",
  mime: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-long"),
};
function fixture(total = 23) {
  let saved: unknown = null;
  let nativeCalls = 0;
  const starts: number[] = [];
  const store = {
    load: async () => saved,
    save: async (v: unknown) => {
      saved = JSON.parse(JSON.stringify(v));
    },
  };
  const primary = {
    extract: async () => {
      nativeCalls++;
      throw new DossierError("OCR_REQUIRED", 409);
    },
  };
  const service = {
    fetch: async (req: Request) => {
      const start = Number(req.headers.get("x-ocr-start-page"));
      const count = Number(req.headers.get("x-ocr-page-count"));
      starts.push(start);
      expect(count).toBe(5);
      const end = Math.min(total, start + count - 1);
      return Response.json({
        parserVersion: "ocr-batch-test",
        pageCount: total,
        startPage: start,
        endPage: end,
        nextPage: end === total ? null : end + 1,
        complete: end === total,
        warnings: [],
        pages: Array.from({ length: end - start + 1 }, (_, i) => ({
          page: start + i,
          text: `Source text on original page ${start + i}`,
        })),
      });
    },
  };
  return {
    store,
    service,
    primary,
    starts,
    nativeCalls: () => nativeCalls,
    saved: () => saved,
  };
}
async function run(s: ReturnType<typeof fixture>, selectedFile = file) {
  return new CpuOcrFallbackProvider(s.primary, s.service, s.store).extract(
    selectedFile,
    AbortSignal.timeout(1000),
  );
}
describe("durable private OCR page batches", () => {
  it("resumes across fresh workers and publishes all original pages only after the final batch", async () => {
    const s = fixture();
    for (let i = 0; i < 4; i++)
      await expect(run(s)).rejects.toMatchObject({ code: "OCR_CONTINUING" });
    const result = await run(s);
    expect(result.complete).toBe(true);
    expect(result.pages.map((p) => p.page)).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 1),
    );
    expect(s.starts).toEqual([1, 6, 11, 16, 21]);
    expect(s.nativeCalls()).toBe(1);
    expect(await run(s)).toEqual(result);
    expect(s.starts).toHaveLength(5);
  });
  it("keeps completed batches after OCR saturation and retries only the next range", async () => {
    const s = fixture(11);
    const original = s.service.fetch;
    let busy = true;
    await expect(run(s)).rejects.toMatchObject({ code: "OCR_CONTINUING" });
    s.service.fetch = async (req) => {
      if (busy) {
        busy = false;
        return Response.json({ error: "OCR_BUSY" }, { status: 429 });
      }
      return original(req);
    };
    await expect(run(s)).rejects.toMatchObject({
      code: "OCR_BUSY",
      retryable: true,
    });
    await expect(run(s)).rejects.toMatchObject({ code: "OCR_CONTINUING" });
    const r = await run(s);
    expect(r.pages).toHaveLength(11);
    expect(s.starts).toEqual([1, 6, 11]);
  });
  it("does not reuse a checkpoint for different original bytes", async () => {
    const s = fixture(6);
    await expect(run(s)).rejects.toMatchObject({ code: "OCR_CONTINUING" });
    await expect(
      run(s, { ...file, bytes: new TextEncoder().encode("%PDF-replacement") }),
    ).rejects.toMatchObject({ code: "OCR_CONTINUING" });
    expect(s.starts).toEqual([1, 1]);
  });
  it.each(["missing", "duplicate", "wrong-total", "false-complete"])(
    "rejects %s pages without persisting an incomplete batch",
    async (fault) => {
      const s = fixture(6);
      const original = s.service.fetch;
      s.service.fetch = async (req) => {
        const body = (await (await original(req)).json()) as any;
        if (fault === "missing") body.pages.pop();
        if (fault === "duplicate") body.pages[1].page = 1;
        if (fault === "wrong-total") body.pageCount = 4;
        if (fault === "false-complete") body.complete = true;
        return Response.json(body);
      };
      await expect(run(s)).rejects.toMatchObject({ code: "OCR_BATCH_INVALID" });
      expect(s.saved()).toBeNull();
    },
  );
  it("preserves blank original pages and their review warning", async () => {
    const s = fixture(6);
    const original = s.service.fetch;
    s.service.fetch = async (req) => {
      const body = (await (await original(req)).json()) as any;
      if (body.startPage === 1) body.pages.forEach((p: any) => (p.text = ""));
      return Response.json(body);
    };
    await expect(run(s)).rejects.toMatchObject({ code: "OCR_CONTINUING" });
    const r: ExtractionResult = await run(s);
    expect(r.pages).toHaveLength(6);
    expect(r.pages[0]).toEqual({ page: 1, text: "" });
    expect(r.warnings).toContain("EMPTY_PAGES_REQUIRE_OCR");
  });
});
