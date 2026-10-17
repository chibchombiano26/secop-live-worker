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
describe("OpenRouter credential boundaries", () => {
  it("uses the Worker secret only in authorization and requests inexpensive private routing", async () => {
    const secret = "private-openrouter-fixture";
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, options) => {
        expect(String(url)).toBe(
          "https://openrouter.ai/api/v1/chat/completions",
        );
        expect(new Headers(options?.headers).get("Authorization")).toBe(
          `Bearer ${secret}`,
        );
        expect(String(options?.body)).not.toContain(secret);
        expect(JSON.parse(String(options?.body)).provider).toEqual({
          sort: "price",
          data_collection: "deny",
          require_parameters: true,
        });
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: '{"answer":"Cited evidence required"}' },
            },
          ],
        });
      });
    try {
      const model = new ConfiguredModel({
        MODEL_NAME: "openai/gpt-oss-20b",
        MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: secret,
      });
      expect(await model.generate(input)).toEqual({
        answer: "Cited evidence required",
      });
    } finally {
      request.mockRestore();
    }
  });
  it("never forwards the OpenRouter secret to a different model host", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    try {
      const model = new ConfiguredModel({
        MODEL_NAME: "test",
        MODEL_URL: "https://other.invalid/chat",
        OPENROUTER_API_KEY: "private-openrouter-fixture",
      });
      await expect(model.generate(input)).rejects.toMatchObject({
        code: "MODEL_UNCONFIGURED",
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
});
