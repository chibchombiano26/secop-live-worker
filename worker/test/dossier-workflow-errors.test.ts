import { describe, it, expect } from "vitest";
import { DossierError } from "../src/dossier/contracts";
import { processingStepResult } from "../src/dossier/jobs";
describe("Workflow processing error transport", () => {
  it.each([
    ["OCR_CONTINUING", 202, true],
    ["OCR_BUSY", 503, true],
    ["OCR_PAGE_LIMIT", 409, false],
  ] as const)(
    "preserves %s across a JSON Workflow boundary",
    async (code, status, retryable) => {
      const result = await processingStepResult(async () => {
        throw new DossierError(code, status, retryable);
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual({
        code,
        status,
        retryable,
      });
    },
  );
  it("serializes only the typed safe model diagnostic across the Workflow boundary", async () => {
    const diagnostic = {
      provider: "DeepInfra" as const,
      phase: "content_json" as const,
      elapsedMs: 812,
      shape: { contentType: "application/json" as const, length: 44 },
      finishReason: "error" as const,
      providerErrorCode: 502,
    };
    const result = await processingStepResult(async () => {
      throw new DossierError("MODEL_INVALID_OUTPUT", 502, true, diagnostic);
    });
    const serialized = JSON.stringify(result);
    expect(JSON.parse(serialized)).toEqual({
      code: "MODEL_INVALID_OUTPUT",
      status: 502,
      retryable: true,
      diagnostic,
    });
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("document");
    expect(serialized).not.toContain("owner");
  });
  it("returns a serializable success and does not expose unknown failures", async () => {
    expect(await processingStepResult(async () => {})).toBeNull();
    await expect(
      processingStepResult(async () => {
        throw new Error("private diagnostic");
      }),
    ).rejects.toThrow("private diagnostic");
  });
});
