import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecopCatalogDependencies } from "../src/public/catalogs.mjs";
import { registerSecopCatalogTool } from "../src/public/catalogs.mjs";

const DATASET = "p6dx-8zbt";
afterEach(() => vi.useRealTimers());

function setup({
  fetch = vi.fn(),
  cache,
  domain,
  kv,
  waitUntil,
}: {
  fetch?: ReturnType<typeof vi.fn>;
  cache?: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  domain?: string;
  kv?: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  waitUntil?: (promise: Promise<unknown>) => void;
} = {}) {
  let toolName = "";
  let config: Record<string, unknown> = {};
  let handler!: (input: { campo: string }) => Promise<unknown>;
  const server = {
    registerTool(
      name: string,
      options: Record<string, unknown>,
      callback: typeof handler,
    ) {
      toolName = name;
      config = options;
      handler = callback;
    },
  };
  registerSecopCatalogTool(server, {
    socrataFetch: fetch as unknown as SecopCatalogDependencies["socrataFetch"],
    dataset: DATASET,
    stringSchema: () => ({ type: "string" }),
    cache: cache as unknown as SecopCatalogDependencies["cache"],
    waitUntil,
    env: (domain
      ? { SOCRATA_DOMAIN: domain, CATALOG_KV: kv }
      : { CATALOG_KV: kv }) as unknown as SecopCatalogDependencies["env"],
  });
  return { fetch, getTool: () => ({ name: toolName, config, handler }) };
}

function resultData(result: any) {
  return JSON.parse(result.content[0].text).data[0];
}

function catalog(values: string[], updatedAt = new Date().toISOString()) {
  return {
    id: "departamento",
    values,
    count: values.length,
    complete: true,
    updated_at: updatedAt,
  };
}

describe("SECOP provider catalog tool", () => {
  it("registers a read-only tool and queries only the allowlisted catalog column", async () => {
    const fetch = vi.fn().mockResolvedValue([{ value: "Cundinamarca" }]);
    const { getTool } = setup({ fetch });
    const tool = getTool();

    expect(tool.name).toBe("opciones_licitaciones");
    expect(tool.config).toMatchObject({
      inputSchema: { campo: { type: "string" } },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    });
    const result = await tool.handler({ campo: "departamento" });
    expect(resultData(result)).toMatchObject({
      id: "departamento",
      values: ["Cundinamarca"],
      count: 1,
      complete: true,
    });
    expect(fetch.mock.calls[0]).toEqual([
      DATASET,
      "SELECT departamento_entidad AS value WHERE departamento_entidad IS NOT NULL GROUP BY departamento_entidad ORDER BY departamento_entidad LIMIT 50000",
      {},
    ]);
  });

  it("returns all distinct values, trimming and removing exact duplicates only", async () => {
    const values = [
      " Valle del Cauca ",
      "Valle del Cauca",
      "valle del cauca",
      "Átlantico",
    ];
    const { getTool } = setup({
      fetch: vi.fn().mockResolvedValue(values.map((value) => ({ value }))),
    });
    const result = await getTool().handler({ campo: "departamento" });
    expect(resultData(result).values).toEqual([
      "Valle del Cauca",
      "valle del cauca",
      "Átlantico",
    ]);
  });

  it("supports all catalog fields with their fixed source columns", async () => {
    const fetch = vi.fn().mockResolvedValue([]);
    const { getTool } = setup({ fetch });
    for (const [campo, source] of [
      ["departamento", "departamento_entidad"],
      ["entidad", "entidad"],
      ["modalidad", "modalidad_de_contratacion"],
    ]) {
      await getTool().handler({ campo });
      expect(fetch.mock.calls.at(-1)![1]).toContain(
        `SELECT ${source} AS value`,
      );
    }
  });

  it("keeps the full 11,881-value entity catalog within the output envelope", async () => {
    const rows = Array.from({ length: 11881 }, (_, index) => ({
      value: `Entidad ${index}`,
    }));
    const { getTool } = setup({ fetch: vi.fn().mockResolvedValue(rows) });
    const result = await getTool().handler({ campo: "entidad" });
    const catalog = resultData(result);
    expect(catalog.values).toHaveLength(11881);
    expect(catalog.count).toBe(11881);
    expect(catalog.complete).toBe(true);
  });

  it("rejects unknown fields before making an upstream request", async () => {
    const fetch = vi.fn();
    const { getTool } = setup({ fetch });
    await expect(getTool().handler({ campo: "q" })).rejects.toThrow(
      "Unsupported catalog field",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the upstream limit is reached", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 50000 }, () => ({ value: "x" })));
    const { getTool } = setup({ fetch });
    await expect(getTool().handler({ campo: "entidad" })).rejects.toThrow(
      "Catalog result may be incomplete",
    );
  });

  it("rejects malformed or non-string upstream rows without exposing details", async () => {
    const fetch = vi.fn().mockResolvedValue([{ value: 42 }]);
    const { getTool } = setup({ fetch });
    await expect(getTool().handler({ campo: "entidad" })).rejects.toThrow(
      "Catalog request failed",
    );
  });

  it("fails closed when the serialized tool response exceeds the safe size", async () => {
    const fetch = vi.fn().mockResolvedValue([{ value: "x".repeat(800000) }]);
    const { getTool } = setup({ fetch });
    await expect(getTool().handler({ campo: "entidad" })).rejects.toThrow(
      "Catalog response is too large",
    );
  });

  it("serves public catalog data from cache and tolerates cache failures", async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockRejectedValue(new Error("cache unavailable")),
    };
    const fetch = vi.fn().mockResolvedValue([{ value: "Bogotá D.C." }]);
    const { getTool } = setup({ fetch, cache });
    await getTool().handler({ campo: "departamento" });
    expect(cache.put).toHaveBeenCalledTimes(1);
    cache.match.mockResolvedValue(cache.put.mock.calls[0][1]);
    await getTool().handler({ campo: "departamento" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats malformed cached values as a cache miss", async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "departamento",
                values: [" ", "Cundinamarca"],
                count: 2,
                complete: true,
                updated_at: new Date().toISOString(),
              },
            ],
          }),
        ),
      ),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const fetch = vi.fn().mockResolvedValue([{ value: "Antioquia" }]);
    const { getTool } = setup({ fetch, cache });
    const result = await getTool().handler({ campo: "departamento" });
    expect(resultData(result).values).toEqual(["Antioquia"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("isolates cache keys and in-flight reads by configured Socrata host", async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const fetch = vi.fn(
      async (
        _dataset: string,
        _query: string,
        env: { SOCRATA_DOMAIN?: string },
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [{ value: env.SOCRATA_DOMAIN ?? "default" }];
      },
    );
    const first = setup({ fetch, cache, domain: "first.example.gov" });
    const second = setup({ fetch, cache, domain: "second.example.gov" });

    const [firstResult, secondResult] = await Promise.all([
      first.getTool().handler({ campo: "departamento" }),
      second.getTool().handler({ campo: "departamento" }),
    ]);
    expect(resultData(firstResult).values).toEqual(["first.example.gov"]);
    expect(resultData(secondResult).values).toEqual(["second.example.gov"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache.match.mock.calls[0][0].url).toContain("first.example.gov");
    expect(cache.match.mock.calls[1][0].url).toContain("second.example.gov");
  });

  it("serves a fresh backend KV snapshot without reading edge cache or Socrata", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(catalog(["Caldas"])),
      put: vi.fn(),
    };
    const cache = { match: vi.fn(), put: vi.fn() };
    const fetch = vi.fn();
    const { getTool } = setup({ fetch, cache, kv });

    const result = await getTool().handler({ campo: "departamento" });
    expect(resultData(result).values).toEqual(["Caldas"]);
    expect(kv.get).toHaveBeenCalledWith(
      "secop-catalog:v1:www.datos.gov.co:p6dx-8zbt:departamento",
      "json",
    );
    expect(cache.match).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a stale KV snapshot immediately and refreshes KV and edge cache in the background", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    const stale = catalog(
      ["Caldas"],
      new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    );
    const kv = {
      get: vi.fn().mockResolvedValue(stale),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const cache = { match: vi.fn(), put: vi.fn().mockResolvedValue(undefined) };
    const fetch = vi.fn().mockResolvedValue([{ value: "Antioquia" }]);
    const background: Promise<unknown>[] = [];
    const { getTool } = setup({
      fetch,
      cache,
      kv,
      waitUntil: (promise) => background.push(promise),
    });

    const result = await getTool().handler({ campo: "departamento" });
    expect(resultData(result).values).toEqual(["Caldas"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(background).toHaveLength(1);
    await background[0];
    expect(kv.put).toHaveBeenCalledWith(
      "secop-catalog:v1:www.datos.gov.co:p6dx-8zbt:departamento",
      expect.stringContaining("Antioquia"),
    );
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(
      new Headers(cache.put.mock.calls[0][1].headers).get("cache-control"),
    ).toBe("public, max-age=21600");
  });

  it("keeps the stale snapshot when background refresh fails", async () => {
    const stale = catalog(
      ["Caldas"],
      new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    );
    const kv = { get: vi.fn().mockResolvedValue(stale), put: vi.fn() };
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    const background: Promise<unknown>[] = [];
    const { getTool } = setup({
      fetch,
      kv,
      waitUntil: (promise) => background.push(promise),
    });

    const result = await getTool().handler({ campo: "departamento" });
    expect(resultData(result).values).toEqual(["Caldas"]);
    await background[0];
    expect(kv.put).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to Socrata when KV and edge cache reads and writes fail", async () => {
    const kv = {
      get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      put: vi.fn().mockRejectedValue(new Error("KV unavailable")),
    };
    const cache = {
      match: vi.fn().mockRejectedValue(new Error("edge unavailable")),
      put: vi.fn().mockRejectedValue(new Error("edge unavailable")),
    };
    const fetch = vi.fn().mockResolvedValue([{ value: "Caldas" }]);
    const { getTool } = setup({ fetch, cache, kv });

    const result = await getTool().handler({ campo: "departamento" });
    expect(resultData(result).values).toEqual(["Caldas"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent cold reads for the same catalog key", async () => {
    let resolveFetch!: (rows: unknown[]) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(
      (resolve) => (markFetchStarted = resolve),
    );
    const fetch = vi.fn(() => {
      markFetchStarted();
      return new Promise<unknown[]>((resolve) => (resolveFetch = resolve));
    });
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const { getTool } = setup({ fetch, cache, kv });
    const handler = getTool().handler;

    const first = handler({ campo: "departamento" });
    const second = handler({ campo: "departamento" });
    await fetchStarted;
    resolveFetch([{ value: "Caldas" }]);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(resultData(firstResult).values).toEqual(["Caldas"]);
    expect(resultData(secondResult).values).toEqual(["Caldas"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
