import { describe, it, expect, vi } from "vitest";
import { ConfiguredModel } from "../src/dossier/model";
const input = {
  purpose: "test",
  evidence: [],
  instructions: "Return JSON only.",
};
describe("configured model boundaries", () => {
  it("accepts structured Workers AI JSON responses without exposing environment secrets to the prompt", async () => {
    const run = vi.fn(async (_name: string, body: any) => {
      expect(JSON.stringify(body)).not.toContain("private-provider-secret");
      return { response: { answer: "Evidence required" } };
    });
    const model = new ConfiguredModel({
      MODEL_NAME: "@cf/test",
      MODEL_KEY: "private-provider-secret",
      AI: { run },
    });
    expect(await model.generate(input)).toEqual({
      answer: "Evidence required",
    });
  });
  it("supplies the output schema to Workers AI", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    const run = vi.fn(async (_name: string, _body: any) => ({
      response: { answer: "ok" },
    }));
    await new ConfiguredModel({ MODEL_NAME: "@cf/test", AI: { run } }).generate(
      { ...input, outputSchema: schema },
    );
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      response_format: { type: "json_schema", json_schema: schema },
    });
  });
  it("honors a smaller configured provider context budget", async () => {
    const model = new ConfiguredModel({
      MODEL_NAME: "@cf/test",
      MODEL_MAX_INPUT_CHARS: "50000",
      AI: { run: async () => ({ response: {} }) },
    });
    await expect(
      model.generate({ ...input, instructions: "x".repeat(50001) }),
    ).rejects.toThrow("MODEL_CONTEXT_LIMIT");
  });
  it("enforces explicit call and context budgets", async () => {
    const model = new ConfiguredModel({
      MODEL_NAME: "@cf/test",
      MODEL_MAX_CALLS: "1",
      AI: { run: async () => ({ response: "{}" }) },
    });
    await model.generate(input);
    await expect(model.generate(input)).rejects.toThrow(
      "MODEL_BUDGET_EXCEEDED",
    );
    const fresh = new ConfiguredModel({
      MODEL_NAME: "@cf/test",
      AI: { run: async () => ({ response: "{}" }) },
    });
    await expect(
      fresh.generate({ ...input, instructions: "x".repeat(120001) }),
    ).rejects.toThrow("MODEL_CONTEXT_LIMIT");
  });
});
