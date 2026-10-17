import { describe, it, expect } from "vitest";
import {
  CpuOcrFallbackProvider,
  CloudflareExtractionProvider,
  type ExtractionProvider,
} from "../src/dossier/extraction";
import { DossierError } from "../src/dossier/contracts";
const file = {
  name: "scan.pdf",
  mime: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.7"),
};
const native = {
  parserVersion: "native",
  pages: [{ page: 1, text: "Readable source text" }],
  warnings: [],
  complete: true,
};
const ocr = {
  ...native,
  parserVersion: "cpu-ocr",
  warnings: ["OCR_TEXT_REQUIRES_REVIEW"],
};
function setup(
  primary: ExtractionProvider,
  response: Response = Response.json(ocr),
) {
  let calls = 0;
  const provider = new CpuOcrFallbackProvider(primary, {
    fetch: async (request: Request) => {
      calls++;
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe("application/pdf");
      expect(await request.text()).toBe("%PDF-1.7");
      return response;
    },
  });
  return { provider, calls: () => calls };
}
describe("private CPU OCR fallback", () => {
  it("detects empty pages in a partially readable native PDF instead of dropping them", async () => {
    const primary = new CloudflareExtractionProvider({
      toMarkdown: async () => ({
        format: "markdown",
        data: "### Page 1\nReadable source text\n### Page 2\n\n",
      }),
    });
    const extracted = await primary.extract(file, AbortSignal.timeout(1000));
    expect(extracted.pages).toHaveLength(2);
    expect(extracted.warnings).toContain("EMPTY_PAGES_REQUIRE_OCR");
    const s = setup(primary);
    await s.provider.extract(file, AbortSignal.timeout(1000));
    expect(s.calls()).toBe(1);
  });
  it("does not send readable PDFs or non-PDF documents to OCR", async () => {
    const s = setup({ extract: async () => native });
    expect(await s.provider.extract(file, AbortSignal.timeout(1000))).toEqual(
      native,
    );
    expect(s.calls()).toBe(0);
    const unsupported = setup({
      extract: async () => {
        throw new DossierError("OCR_REQUIRED", 409);
      },
    });
    await expect(
      unsupported.provider.extract(
        { ...file, mime: "application/msword" },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("OCR_REQUIRED");
    expect(unsupported.calls()).toBe(0);
  });
  it("uses OCR when a PDF has no text or has unextracted pages", async () => {
    for (const primary of [
      {
        extract: async () => {
          throw new DossierError("OCR_REQUIRED", 409);
        },
      },
      {
        extract: async () => ({
          ...native,
          warnings: ["EMPTY_PAGES_REQUIRE_OCR"],
        }),
      },
    ]) {
      const s = setup(primary);
      expect(
        (await s.provider.extract(file, AbortSignal.timeout(1000)))
          .parserVersion,
      ).toBe("cpu-ocr");
      expect(s.calls()).toBe(1);
    }
  });
  it("retries service saturation but preserves permanent limits and incomplete extraction", async () => {
    const primary = {
      extract: async () => {
        throw new DossierError("OCR_REQUIRED", 409);
      },
    };
    await expect(
      setup(primary, new Response("", { status: 429 })).provider.extract(
        file,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "OCR_BUSY", retryable: true });
    await expect(
      setup(
        primary,
        Response.json({ error: "OCR_PAGE_LIMIT" }, { status: 413 }),
      ).provider.extract(file, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "OCR_PAGE_LIMIT", retryable: false });
    await expect(
      setup(
        primary,
        Response.json({ ...ocr, complete: false }),
      ).provider.extract(file, AbortSignal.timeout(1000)),
    ).rejects.toThrow("EXTRACTION_INCOMPLETE");
  });
  it("can OCR PDFs even when no native extractor is configured", async () => {
    const s = setup({
      extract: async () => {
        throw new DossierError("EXTRACTOR_UNCONFIGURED", 503);
      },
    });
    expect(
      (await s.provider.extract(file, AbortSignal.timeout(1000))).parserVersion,
    ).toBe("cpu-ocr");
  });
  it("does not repeatedly charge CPU time after a deterministic OCR deadline", async () => {
    const s = setup(
      {
        extract: async () => {
          throw new DossierError("OCR_REQUIRED", 409);
        },
      },
      Response.json({ error: "OCR_TIMEOUT" }, { status: 504 }),
    );
    await expect(
      s.provider.extract(file, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "OCR_TIMEOUT", retryable: false });
  });
  it("does not turn source failures into OCR requests", async () => {
    const s = setup({
      extract: async () => {
        throw new DossierError("HUMAN_HELP_REQUIRED", 409);
      },
    });
    await expect(
      s.provider.extract(file, AbortSignal.timeout(1000)),
    ).rejects.toThrow("HUMAN_HELP_REQUIRED");
    expect(s.calls()).toBe(0);
  });
});
