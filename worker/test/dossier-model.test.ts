import { describe, it, expect, vi } from "vitest";
import { ConfiguredModel } from "../src/dossier/model";
import { processingStepResult } from "../src/dossier/jobs";
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
  it("retries transient Workers AI failures within the physical attempt budget", async () => {
    let attempts = 0;
    const run = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new TypeError("temporary network failure");
      return { response: { answer: "ok" } };
    });
    const consumeBudget = vi.fn(async () => {});
    const model = new ConfiguredModel(
      { MODEL_NAME: "@cf/test", AI: { run } },
      undefined,
      consumeBudget,
      { retryDelayMs: 0, sleep: async () => {} },
    );

    expect(await model.generate(input)).toEqual({ answer: "ok" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(consumeBudget).toHaveBeenCalledTimes(2);
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
  it("accepts a validated provider sort while retaining privacy constraints", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, options) => {
        expect(JSON.parse(String(options?.body)).provider).toEqual({
          sort: "throughput",
          data_collection: "deny",
          require_parameters: true,
          max_price: { prompt: 0.15, completion: 0.75 },
        });
        return Response.json({
          choices: [{ message: { content: '{"answer":"ok"}' } }],
        });
      });
    try {
      const model = new ConfiguredModel({
        MODEL_NAME: "test",
        MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "private-fixture",
        MODEL_PROVIDER_SORT: "throughput",
        MODEL_MAX_PRICE_PROMPT: "0.15",
        MODEL_MAX_PRICE_COMPLETION: "0.75",
      });
      await expect(model.generate(input)).resolves.toEqual({ answer: "ok" });
    } finally {
      request.mockRestore();
    }
  });
  it("rejects unsupported provider sort values without sending a request", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    try {
      const model = new ConfiguredModel({
        MODEL_NAME: "test",
        MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "private-fixture",
        MODEL_PROVIDER_SORT: "cheapest",
      });
      await expect(model.generate(input)).rejects.toMatchObject({
        code: "MODEL_PROVIDER_SORT_INVALID",
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
  it.each([
    [{ MODEL_MAX_PRICE_PROMPT: "0.15" }],
    [{ MODEL_MAX_PRICE_PROMPT: "0", MODEL_MAX_PRICE_COMPLETION: "0.75" }],
    [
      {
        MODEL_MAX_PRICE_PROMPT: "0.15",
        MODEL_MAX_PRICE_COMPLETION: "Infinity",
      },
    ],
  ])("rejects invalid or incomplete max-price settings before inference", async (settings) => {
    const request = vi.spyOn(globalThis, "fetch");
    try {
      const model = new ConfiguredModel({
        MODEL_NAME: "test",
        MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "private-fixture",
        ...settings,
      });
      await expect(model.generate(input)).rejects.toMatchObject({
        code: "MODEL_MAX_PRICE_INVALID",
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
});

describe("provider failure classification", () => {
  it.each([
    [401, false],
    [402, false],
    [429, true],
    [500, true],
    [503, true],
  ])(
    "retains HTTP %i, cancels unused bodies, and avoids logging response content",
    async (status, retryable) => {
      let cancelledBodies = 0;
      const request = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            new ReadableStream({
              cancel: () => {
                cancelledBodies++;
                return Promise.reject(new Error("private body cancellation"));
              },
            }),
            { status },
          ),
      );
      const consumeBudget = vi.fn(async () => {});
      try {
        const model = new ConfiguredModel(
          {
            MODEL_NAME: "test",
            MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
            OPENROUTER_API_KEY: "private-fixture",
          },
          undefined,
          consumeBudget,
          { retryDelayMs: 0, sleep: async () => {} },
        );
        await expect(model.generate(input)).rejects.toMatchObject({
          code: `MODEL_PROVIDER_HTTP_${status}`,
          retryable,
        });
        expect(request).toHaveBeenCalledTimes(retryable ? 3 : 1);
        expect(consumeBudget).toHaveBeenCalledTimes(retryable ? 3 : 1);
        expect(cancelledBodies).toBe(retryable ? 3 : 1);
      } finally {
        request.mockRestore();
      }
    },
  );
});

describe("OpenRouter structured responses", () => {
  it("sends the evidence response schema as a strict provider constraint", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, options) => {
        expect(JSON.parse(String(options?.body)).response_format).toEqual({
          type: "json_schema",
          json_schema: { name: "secop_response", schema, strict: true },
        });
        return Response.json({
          choices: [{ message: { content: '{"answer":"ok"}' } }],
        });
      });
    try {
      await new ConfiguredModel({
        MODEL_NAME: "openai/gpt-oss-20b",
        MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "private-fixture",
      }).generate({ ...input, outputSchema: schema });
    } finally {
      request.mockRestore();
    }
  });
});

describe("model response body timeouts", () => {
  it("serializes a stalled response-body timeout as a typed retryable workflow error", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, options) => {
        const signal = options?.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            );
          },
        });
        return new Response(body, { status: 200 });
      });
    try {
      const model = new ConfiguredModel(
        {
          MODEL_NAME: "test",
          MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
          OPENROUTER_API_KEY: "private-fixture",
        },
        undefined,
        undefined,
        {
          requestTimeoutMs: 5,
          retryDelayMs: 0,
          sleep: async () => {},
        },
      );

      const failure = await processingStepResult(async () => {
        await model.generate(input);
      });

      expect(failure).toEqual({
        code: "MODEL_UNAVAILABLE",
        status: 502,
        retryable: true,
      });
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      request.mockRestore();
    }
  });

  it("charges and heartbeats each physical attempt when transient network failures recover", async () => {
    let attempts = 0;
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        attempts++;
        if (attempts < 3) throw new TypeError("network failure");
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: '{"answer":"ok"}' },
            },
          ],
        });
      });
    const heartbeat = vi.fn(async () => {});
    const consumeBudget = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});
    try {
      const model = new ConfiguredModel(
        {
          MODEL_NAME: "test",
          MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
          OPENROUTER_API_KEY: "private-fixture",
        },
        heartbeat,
        consumeBudget,
        { sleep },
      );

      expect(await model.generate(input)).toEqual({ answer: "ok" });
      expect(request).toHaveBeenCalledTimes(3);
      expect(consumeBudget).toHaveBeenCalledTimes(3);
      expect(heartbeat).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls).toEqual([[250], [500]]);
    } finally {
      request.mockRestore();
    }
  });

  it("stops immediately when the per-job attempt budget runs out during retry", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("network failure"));
    const consumeBudget = vi.fn(async () => {});
    try {
      const model = new ConfiguredModel(
        {
          MODEL_NAME: "test",
          MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
          OPENROUTER_API_KEY: "private-fixture",
          MODEL_MAX_CALLS: "1",
        },
        undefined,
        consumeBudget,
        { retryDelayMs: 0, sleep: async () => {} },
      );

      await expect(model.generate(input)).rejects.toMatchObject({
        code: "MODEL_BUDGET_EXCEEDED",
        retryable: false,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(consumeBudget).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    [
      "malformed provider JSON",
      new Response("not-json"),
      "MODEL_INVALID_OUTPUT",
    ],
    ["invalid provider structure", Response.json(null), "MODEL_INVALID_OUTPUT"],
    [
      "truncated model output",
      Response.json({ choices: [{ finish_reason: "length" }] }),
      "MODEL_OUTPUT_TRUNCATED",
    ],
  ])("does not retry %s", async (_description, response, code) => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      const model = new ConfiguredModel(
        {
          MODEL_NAME: "test",
          MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
          OPENROUTER_API_KEY: "private-fixture",
        },
        undefined,
        undefined,
        { retryDelayMs: 0, sleep: async () => {} },
      );

      await expect(model.generate(input)).rejects.toMatchObject({ code });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });
});
