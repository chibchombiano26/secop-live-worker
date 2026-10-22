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
  it("opts into Workers AI while preserving the configured model cache identity", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    const run = vi.fn(async (name: string, body: any) => {
      expect(name).toBe("@cf/openai/gpt-oss-120b");
      expect(body.messages[1].content).toContain("Return JSON only.");
      expect(body.response_format).toEqual({
        type: "json_schema",
        json_schema: schema,
      });
      return {
        choices: [
          { finish_reason: "stop", message: { content: '{"answer":"ok"}' } },
        ],
      };
    });
    const model = new ConfiguredModel({
      MODEL_NAME: "openai/gpt-oss-120b",
      MODEL_TRANSPORT: "workers_ai",
      AI: { run },
    });

    expect(model.id).toBe("openai/gpt-oss-120b");
    await expect(
      model.generate({ ...input, outputSchema: schema }),
    ).resolves.toEqual({ answer: "ok" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("maps the configured expert model to its allowlisted Workers AI route", async () => {
    const run = vi.fn(async (name: string) => {
      expect(name).toBe("@cf/openai/gpt-oss-20b");
      return {
        choices: [
          { finish_reason: "stop", message: { content: '{"answer":"ok"}' } },
        ],
      };
    });
    const model = new ConfiguredModel({
      MODEL_NAME: "openai/gpt-oss-20b",
      MODEL_TRANSPORT: "workers_ai",
      AI: { run },
    });

    expect(model.id).toBe("openai/gpt-oss-20b");
    await expect(model.generate(input)).resolves.toEqual({ answer: "ok" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("keeps supporting the legacy Workers AI response envelope on explicit transport", async () => {
    const run = vi.fn(async (name: string) => {
      expect(name).toBe("@cf/openai/gpt-oss-120b");
      return { response: { answer: "legacy" } };
    });
    const model = new ConfiguredModel({
      MODEL_NAME: "openai/gpt-oss-120b",
      MODEL_TRANSPORT: "workers_ai",
      AI: { run },
    });

    await expect(model.generate(input)).resolves.toEqual({ answer: "legacy" });
  });
  it("fails explicit Workers AI transport configuration when the binding is absent", async () => {
    const consumeBudget = vi.fn(async () => {});
    const request = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        new ConfiguredModel(
          {
            MODEL_NAME: "openai/gpt-oss-120b",
            MODEL_TRANSPORT: "workers_ai",
          },
          undefined,
          consumeBudget,
        ).generate(input),
      ).rejects.toMatchObject({ code: "MODEL_UNCONFIGURED" });
      expect(consumeBudget).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
  it("rejects unallowlisted explicit Workers AI models before spending budget", async () => {
    const run = vi.fn();
    const consumeBudget = vi.fn(async () => {});
    await expect(
      new ConfiguredModel(
        {
          MODEL_NAME: "openai/other-model",
          MODEL_TRANSPORT: "workers_ai",
          AI: { run },
        },
        undefined,
        consumeBudget,
      ).generate(input),
    ).rejects.toMatchObject({ code: "MODEL_UNCONFIGURED" });
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("keeps the Workers AI output length signal for recursive splitting", async () => {
    const run = vi.fn(async () => ({
      choices: [
        { finish_reason: "length", message: { content: "private partial" } },
      ],
    }));
    const failure = await new ConfiguredModel({
      MODEL_NAME: "openai/gpt-oss-120b",
      MODEL_TRANSPORT: "workers_ai",
      AI: { run },
    })
      .generate(input)
      .catch((error) => error);

    expect(failure).toMatchObject({ code: "MODEL_OUTPUT_TRUNCATED" });
    expect(failure).toMatchObject({
      diagnostic: {
        provider: "Workers AI",
        phase: "output_truncated",
        finishReason: "length",
        shape: { contentType: "workers_ai", length: 15 },
      },
    });
    expect(JSON.stringify(failure)).not.toContain("private partial");
    expect(run).toHaveBeenCalledTimes(1);
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
  it("keeps only allowlisted metadata from an OpenRouter HTTP error body", async () => {
    const secret = "private-openrouter-error-body";
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          error: {
            code: 403,
            message: secret,
            metadata: {
              error_type: "permission_denied",
              provider_name: "Groq",
              prompt: "private prompt that must not escape",
            },
          },
          arbitrary: "private arbitrary payload",
        },
        { status: 403 },
      ),
    );
    try {
      const failure = await new ConfiguredModel({
        MODEL_NAME: "test",
        MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "private-key",
      })
        .generate(input)
        .catch((error) => error);

      expect(failure).toMatchObject({
        code: "MODEL_PROVIDER_HTTP_403",
        retryable: false,
        diagnostic: {
          provider: "Groq",
          phase: "provider_error",
          providerErrorCode: 403,
          errorType: "permission_denied",
        },
      });
      expect(request).toHaveBeenCalledTimes(1);
      const serialized = JSON.stringify(failure);
      for (const privateValue of [
        secret,
        "private prompt that must not escape",
        "private arbitrary payload",
        "private-key",
      ])
        expect(serialized).not.toContain(privateValue);
    } finally {
      request.mockRestore();
    }
  });

  it("does not expose arbitrary non-JSON OpenRouter HTTP error bodies", async () => {
    const secret = "private body text: prompt, account, and provider details";
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(secret, {
        status: 403,
        headers: { "content-type": "text/plain" },
      }),
    );
    try {
      const failure = await new ConfiguredModel({
        MODEL_NAME: "test",
        MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "private-key",
      })
        .generate(input)
        .catch((error) => error);

      expect(failure).toMatchObject({
        code: "MODEL_PROVIDER_HTTP_403",
        retryable: false,
        diagnostic: {
          provider: "OpenRouter",
          phase: "provider_error",
          shape: { contentType: "text/plain" },
        },
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain("private-key");
    } finally {
      request.mockRestore();
    }
  });

  it("bounds OpenRouter HTTP error body reads", async () => {
    let bodyCancelled = false;
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(9000).fill(0x78));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    try {
      const failure = await new ConfiguredModel({
        MODEL_NAME: "test",
        MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "private-key",
      })
        .generate(input)
        .catch((error) => error);

      expect(failure).toMatchObject({
        code: "MODEL_PROVIDER_HTTP_403",
        retryable: false,
        diagnostic: {
          provider: "OpenRouter",
          phase: "provider_error",
        },
      });
      expect(failure.diagnostic.providerErrorCode).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
      expect(bodyCancelled).toBe(true);
      expect(JSON.stringify(failure)).not.toContain("x".repeat(200));
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    [
      "key_limit",
      {
        error: {
          code: 403,
          message: "private per-key limit message",
          metadata: { limit_source: "openrouter_key_limit", limit_usd: 10 },
        },
      },
    ],
    [
      "guardrail",
      {
        error: {
          code: 403,
          message: "private guardrail message",
          metadata: { limit_source: "openrouter_guardrail_budget" },
        },
      },
    ],
    [
      "guardrail",
      {
        error: {
          code: 403,
          message: "private pipeline block",
          metadata: { private_field: "private pipeline metadata" },
        },
        openrouter_metadata: {
          pipeline: [{ type: "guardrail", summary: "private stage details" }],
        },
      },
    ],
    [
      "budget_limit",
      {
        error: {
          code: 403,
          message: "Budget limit exceeded (private workspace details)",
          metadata: { limit_source: "openrouter_workspace_budget" },
        },
      },
    ],
    [
      "budget_limit",
      {
        error: {
          code: 403,
          message: "Budget limit exceeded (private budget information)",
        },
      },
    ],
    [
      "provider_policy",
      {
        error: {
          code: 403,
          message: "private content policy message",
          metadata: { error_type: "content_policy_violation" },
        },
      },
    ],
    [
      "guardrail",
      {
        error: {
          code: 403,
          message: "Request blocked: private guardrail rule",
          metadata: { patterns: ["private matching pattern"] },
        },
      },
    ],
    [
      "unknown",
      {
        error: {
          code: 403,
          message: "private unfamiliar provider response",
          metadata: { private_field: "private metadata value" },
        },
      },
    ],
  ] as const)(
    "classifies 403 as %s without persisting response text",
    async (cause, body) => {
      const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json(body, { status: 403 }),
      );
      try {
        const failure = await new ConfiguredModel({
          MODEL_NAME: "test",
          MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
          OPENROUTER_API_KEY: "private-key",
        })
          .generate(input)
          .catch((error) => error);

        expect(failure).toMatchObject({
          code: "MODEL_PROVIDER_HTTP_403",
          retryable: false,
          diagnostic: { http403Cause: cause },
        });
        expect(request).toHaveBeenCalledTimes(1);
        const serialized = JSON.stringify(failure);
        for (const privateValue of [
          "private per-key limit message",
          "private guardrail message",
          "private workspace details",
          "private content policy message",
          "private guardrail rule",
          "private matching pattern",
          "private pipeline block",
          "private pipeline metadata",
          "private stage details",
          "private budget information",
          "private unfamiliar provider response",
          "private metadata value",
          "private-key",
        ])
          expect(serialized).not.toContain(privateValue);
      } finally {
        request.mockRestore();
      }
    },
  );

  it.each([
    [401, false],
    [402, false],
    [429, true],
    [500, true],
    [503, true],
  ])(
    "retains HTTP %i and avoids logging response content",
    async (status, retryable) => {
      const request = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          Response.json(
            { error: { code: status, message: "private provider response" } },
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
        const failure = await model.generate(input).catch((error) => error);
        expect(failure).toMatchObject({
          code: `MODEL_PROVIDER_HTTP_${status}`,
          retryable,
        });
        expect(request).toHaveBeenCalledTimes(retryable ? 3 : 1);
        expect(consumeBudget).toHaveBeenCalledTimes(retryable ? 3 : 1);
        expect(JSON.stringify(failure)).not.toContain(
          "private provider response",
        );
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

describe("OpenRouter embedded provider errors", () => {
  const env = {
    MODEL_NAME: "openai/gpt-oss-20b",
    MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
    OPENROUTER_API_KEY: "private-fixture",
    MODEL_MAX_PRICE_PROMPT: "0.15",
    MODEL_MAX_PRICE_COMPLETION: "0.75",
  };

  it("discards partial choice content, then ignores only the failed provider on retry", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    let attempts = 0;
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, options) => {
        attempts++;
        const body = JSON.parse(String(options?.body));
        expect(body.model).toBe(env.MODEL_NAME);
        expect(body.response_format.json_schema.schema).toEqual(schema);
        expect(body.provider.sort).toBe("price");
        expect(body.provider.data_collection).toBe("deny");
        expect(body.provider.require_parameters).toBe(true);
        expect(body.provider.max_price).toEqual({ prompt: 0.15, completion: 0.75 });
        if (attempts === 1) {
          expect(body.provider.ignore).toBeUndefined();
          return Response.json({
            provider: "Groq",
            choices: [
              {
                finish_reason: "error",
                error: {
                  code: 502,
                  message: "private provider error text",
                  metadata: {
                    error_type: "provider_overloaded",
                    provider_name: "Groq",
                  },
                },
                message: { content: '{"answer":"must not be accepted"}' },
              },
            ],
          });
        }
        expect(body.provider.ignore).toEqual(["groq"]);
        return Response.json({
          choices: [
            { finish_reason: "stop", message: { content: '{"answer":"ok"}' } },
          ],
        });
      },
    );
    try {
      const model = new ConfiguredModel(env, undefined, undefined, {
        retryDelayMs: 0,
        sleep: async () => {},
      });
      expect(await model.generate({ ...input, outputSchema: schema })).toEqual({
        answer: "ok",
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    [401, "authentication"],
    [402, "payment_required"],
    [403, "permission_denied"],
    [400, "invalid_request"],
    [400, "content_policy_violation"],
  ])("does not retry embedded HTTP %i %s errors", async (code, errorType) => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        provider: "Groq",
        error: {
          code,
          message: "private provider error text",
          metadata: { error_type: errorType },
        },
        choices: [
          {
            finish_reason: "error",
            message: { content: '{"answer":"partial private content"}' },
          },
        ],
      }),
    );
    try {
      const failure = await new ConfiguredModel(env, undefined, undefined, {
        retryDelayMs: 0,
        sleep: async () => {},
      })
        .generate(input)
        .catch((error) => error);
      expect(failure).toMatchObject({
        code: "MODEL_PROVIDER_ERROR",
        retryable: false,
        diagnostic: {
          phase: "provider_error",
          provider: "Groq",
          providerErrorCode: code,
          errorType,
        },
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(failure)).not.toContain("private provider error text");
      expect(JSON.stringify(failure)).not.toContain("partial private content");
    } finally {
      request.mockRestore();
    }
  });

  it("does not retry refusal errors without a numeric provider code", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        provider: "Groq",
        choices: [
          {
            finish_reason: "error",
            error: {
              message: "private refusal detail",
              metadata: { error_type: "refusal", provider_name: "Groq" },
            },
            message: { content: "private partial" },
          },
        ],
      }),
    );
    try {
      const failure = await new ConfiguredModel(env)
        .generate(input)
        .catch((error) => error);
      expect(failure).toMatchObject({
        code: "MODEL_PROVIDER_ERROR",
        retryable: false,
        diagnostic: {
          phase: "provider_error",
          errorType: "refusal",
        },
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(failure)).not.toContain("private refusal detail");
      expect(JSON.stringify(failure)).not.toContain("private partial");
    } finally {
      request.mockRestore();
    }
  });

  it("classifies a root-level 502 with partial content as transient and keeps only safe diagnostics", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        provider: "Groq",
        error: {
          code: 502,
          message: "private root error text",
          metadata: { error_type: "server" },
        },
        choices: [
          {
            finish_reason: "error",
            message: { content: '{"answer":"partial private content"}' },
          },
        ],
      }),
    );
    const consumeBudget = vi.fn(async () => {});
    try {
      const failure = await new ConfiguredModel(
        env,
        undefined,
        consumeBudget,
        { retryDelayMs: 0, sleep: async () => {} },
      )
        .generate(input)
        .catch((error) => error);
      expect(failure).toMatchObject({
        code: "MODEL_PROVIDER_HTTP_502",
        retryable: true,
        diagnostic: {
          provider: "Groq",
          phase: "provider_error",
          providerErrorCode: 502,
          errorType: "server",
          finishReason: "error",
          shape: { length: 36 },
        },
      });
      expect(request).toHaveBeenCalledTimes(3);
      expect(consumeBudget).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(failure)).not.toContain("private root error text");
      expect(JSON.stringify(failure)).not.toContain("partial private content");
    } finally {
      request.mockRestore();
    }
  });

  it("charges each embedded transient attempt and stops at the configured budget", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        provider: "Groq",
        choices: [
          {
            finish_reason: "error",
            error: {
              code: 503,
              metadata: {
                error_type: "provider_unavailable",
                provider_name: "Groq",
              },
            },
            message: { content: "partial" },
          },
        ],
      }),
    );
    const consumeBudget = vi.fn(async () => {});
    try {
      const failure = await new ConfiguredModel(
        { ...env, MODEL_MAX_CALLS: "1" },
        undefined,
        consumeBudget,
        { retryDelayMs: 0, sleep: async () => {} },
      )
        .generate(input)
        .catch((error) => error);
      expect(failure).toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
      expect(request).toHaveBeenCalledTimes(1);
      expect(consumeBudget).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });

  it("maps token-limit provider errors to output truncation for splitting", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        error: {
          code: 400,
          metadata: { error_type: "token_limit_exceeded" },
        },
        choices: [{ finish_reason: "error", message: { content: "partial" } }],
      }),
    );
    try {
      const failure = await new ConfiguredModel(env)
        .generate(input)
        .catch((error) => error);
      expect(failure).toMatchObject({
        code: "MODEL_OUTPUT_TRUNCATED",
        retryable: true,
      });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });

  it("does not treat an explicit null error field as a provider failure", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        error: null,
        choices: [
          { finish_reason: "stop", message: { content: '{"answer":"ok"}' } },
        ],
      }),
    );
    try {
      expect(await new ConfiguredModel(env).generate(input)).toEqual({
        answer: "ok",
      });
      expect(request).toHaveBeenCalledTimes(1);
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

  it("classifies invalid provider envelope JSON without retaining its body", async () => {
    const response = new Response("private-response-body", {
      headers: { "content-type": "text/html; secret=hidden" },
    });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      let failure: unknown;
      try {
        await new ConfiguredModel({
          MODEL_NAME: "test",
          MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
          OPENROUTER_API_KEY: "private-key",
        }).generate(input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "MODEL_INVALID_OUTPUT",
        retryable: true,
        diagnostic: {
          provider: "OpenRouter",
          phase: "provider_envelope_json",
          shape: { contentType: "other", length: 21 },
        },
      });
      expect(JSON.stringify(failure)).not.toContain("private-response-body");
      expect(JSON.stringify(failure)).not.toContain("private-key");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });

  it("records only safe provider error metadata and does not retry content filters", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        provider: "Groq",
        error: { code: 502, message: "private provider detail" },
        choices: [{ finish_reason: "content_filter", message: {} }],
      }),
    );
    try {
      let failure: unknown;
      try {
        await new ConfiguredModel({
          MODEL_NAME: "test",
          MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
          OPENROUTER_API_KEY: "private-key",
        }).generate(input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "MODEL_PROVIDER_ERROR",
        retryable: false,
        diagnostic: {
          provider: "Groq",
          phase: "provider_error",
          finishReason: "content_filter",
          providerErrorCode: 502,
        },
      });
      expect(JSON.stringify(failure)).not.toContain("private provider detail");
      expect(JSON.stringify(failure)).not.toContain("private-key");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });

  it("rejects partial content from unknown provider errors and maps providers safely", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        provider: "__proto__",
        choices: [
          {
            finish_reason: "error",
            message: { content: "private model text" },
          },
        ],
      }),
    );
    try {
      let failure: unknown;
      try {
        await new ConfiguredModel({
          MODEL_NAME: "test",
          MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
          OPENROUTER_API_KEY: "private-key",
        }).generate(input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "MODEL_UNAVAILABLE",
        retryable: true,
        diagnostic: {
          provider: "unknown",
          phase: "provider_error",
          finishReason: "error",
          shape: { contentType: "application/json", length: 18 },
        },
      });
      expect(JSON.stringify(failure)).not.toContain("private model text");
      expect(JSON.stringify(failure)).not.toContain("__proto__");
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      request.mockRestore();
    }
  });

  it("classifies malformed Workers AI response shapes", async () => {
    let failure: unknown;
    try {
      await new ConfiguredModel({
        MODEL_NAME: "@cf/test",
        AI: { run: async () => ({ response: ["private", "payload"] }) },
      }).generate(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "MODEL_INVALID_OUTPUT",
      diagnostic: {
        provider: "Workers AI",
        phase: "workers_ai_shape",
        shape: { contentType: "workers_ai" },
      },
    });
    expect(JSON.stringify(failure)).not.toContain("private");
  });
});
