import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { DossierAnalysisCache } from "../src/dossier/analysis-cache";
import { DossierError, PRIVATE_SCOPES } from "../src/dossier/contracts";
import type { ModelProvider } from "../src/dossier/model";
import { DossierRepository } from "../src/dossier/repository";
import {
  extractRequirements,
  synthesizeDossier,
} from "../src/dossier/synthesis";

let mf: Miniflare;
let db: D1Database;
let bucket: R2Bucket;
const now = Date.parse("2026-10-22T12:00:00Z");

function repository(ownerId: string) {
  return new DossierRepository(
    { DOSSIER_DB: db, DOSSIER_FILES: bucket },
    { ownerId, scopes: [...PRIVATE_SCOPES] },
    () => now,
  );
}

function readRepository(all: () => Promise<{ results: unknown[] }>) {
  const db = {
    prepare: () => ({ bind: () => ({ all }) }),
  } as unknown as D1Database;
  return new DossierRepository(
    { DOSSIER_DB: db, DOSSIER_FILES: bucket },
    { ownerId: "cache-read-test", scopes: [...PRIVATE_SCOPES] },
    () => now,
  );
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DOSSIER_DB"],
      r2Buckets: ["DOSSIER_FILES"],
      compatibilityDate: "2026-10-01",
    }),
  );
  db = await mf.getD1Database("DOSSIER_DB");
  bucket = (await mf.getR2Bucket("DOSSIER_FILES")) as unknown as R2Bucket;
  await db.exec(
    readFileSync(new URL("../migrations/0001_dossiers.sql", import.meta.url), "utf8"),
  );
});

afterAll(async () => {
  await mf.dispose();
});

describe("dossier analysis cache", () => {
  it("retries a recognized transient D1 network loss while loading exact cache keys", async () => {
    let calls = 0;
    const repo = readRepository(async () => {
      calls++;
      if (calls === 1) throw new Error("D1_ERROR: Network connection lost");
      return { results: [] };
    });
    const cache = new DossierAnalysisCache(repo);

    await cache.preload(["part.missing"]);

    expect(await cache.get("part.missing")).toBeNull();
    expect(calls).toBe(2);
  });

  it("does not retry unrelated D1 failures while loading cache keys", async () => {
    const failure = new Error("D1_ERROR: no such table");
    let calls = 0;
    const repo = readRepository(async () => {
      calls++;
      throw failure;
    });
    const cache = new DossierAnalysisCache(repo);

    await expect(cache.preload(["part.missing"])).rejects.toBe(failure);

    expect(calls).toBe(1);
  });

  it("retries an ambiguous cache write without incrementing the record twice", async () => {
    const repo = repository("cache-write-retry-owner");
    const database = repo.db;
    let calls = 0;
    const flakyDatabase = new Proxy(database, {
      get(target, property) {
        if (property === "prepare")
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.startsWith("INSERT INTO dossier_records"))
              return statement;
            return {
              bind: (...values: unknown[]) => {
                const bound = statement.bind(...values);
                return {
                  run: async () => {
                    calls++;
                    const result = await bound.run();
                    if (calls === 1)
                      throw new Error("D1_ERROR: Network connection lost");
                    return result;
                  },
                };
              },
            };
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const retryRepo = new DossierRepository(
      { DOSSIER_DB: flakyDatabase, DOSSIER_FILES: bucket },
      repo.context,
      () => now,
    );
    const cache = new DossierAnalysisCache(retryRepo);

    await cache.put("part.ambiguous-write", { requirements: ["saved"] });

    const record = await repo.read<{ requirements: string[] }>(
      "report",
      "part.ambiguous-write",
    );
    expect(calls).toBe(2);
    expect(record.revision).toBe(1);
    expect(record.value).toEqual({ requirements: ["saved"] });
  });

  it("synthesizes and replays with more than 5,000 unrelated owner cache rows", async () => {
    const repo = repository("cache-owner");
    const dossierId = "CO1.REQ.11219655";
    const created = await repo.createOrGetDossier(dossierId);
    await repo.save(
      "dossier",
      dossierId,
      {
        ...created.value,
        corpusRevision: 1,
        state: "ready",
        coverage: { inventoryComplete: true },
        description: {
          description:
            "The buyer must receive the required software and service within 30 days.",
        },
      },
      created.revision,
    );

    await db
      .prepare(
        `WITH RECURSIVE n(value) AS (
           SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 100
         )
         INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at)
         SELECT ?, 'report', 'part.unrelated-' || (a.value * 101 + b.value), 1, '{}', ?
         FROM n AS a CROSS JOIN n AS b
         WHERE a.value * 101 + b.value < 5001`,
      )
      .bind("cache-owner", now)
      .run();

    await expect(repo.readAnalysisCache()).rejects.toMatchObject({
      code: "REPORT_CACHE_CAPACITY_LIMIT",
    });
    const readCache = vi.spyOn(repo, "readAnalysisCache");
    const readMany = vi.spyOn(repo, "readMany");
    let modelCalls = 0;
    const model: ModelProvider = {
      id: "exact-cache-model",
      async generate(input) {
        modelCalls++;
        if (input.purpose === "extract_requirements") {
          const source = input.evidence[0];
          return {
            summary: "Source summary.",
            requirements: [
              {
                wording: "Provide the required software within 30 days.",
                category: "deliverables",
                mandatory: true,
                lot: null,
                deadline: null,
                rule: null,
                citations: [
                  {
                    documentVersionId: source.documentVersionId,
                    ...(source.page === undefined ? {} : { page: source.page }),
                    ...(source.section === undefined
                      ? {}
                      : { section: source.section }),
                    excerpt: source.text.slice(0, 80),
                  },
                ],
              },
            ],
            conflicts: [],
          };
        }
        if (input.purpose === "joint_requirement_review")
          return { summary: "Requisitos identificados.", candidates: [] };
        throw new Error(`Unexpected model purpose: ${input.purpose}`);
      },
    };

    await synthesizeDossier(repo, dossierId, 1, model);
    const callsAfterFirstRun = modelCalls;
    expect(callsAfterFirstRun).toBe(2);
    await synthesizeDossier(repo, dossierId, 1, model);
    expect(modelCalls).toBe(callsAfterFirstRun);
    expect(readCache).not.toHaveBeenCalled();
    const requestedReportIds = readMany.mock.calls
      .filter(([kind]) => kind === "report")
      .flatMap(([, ids]) => ids);
    expect(requestedReportIds.length).toBeGreaterThan(0);
    expect(requestedReportIds.every((id) => /^(part|joint)\./.test(id))).toBe(
      true,
    );
    expect(
      requestedReportIds.some((id) =>
        id.startsWith("part.unrelated-"),
      ),
    ).toBe(false);
  });

  it("keeps cache lookup scoped to the repository owner", async () => {
    const ownerA = repository("cache-owner-a");
    const ownerB = repository("cache-owner-b");
    await ownerB.save("report", "part.shared-key", { secret: "other owner" }, 0);

    const cacheA = new DossierAnalysisCache(ownerA);
    const cacheB = new DossierAnalysisCache(ownerB);
    expect(await cacheA.get("part.shared-key")).toBeNull();
    expect(await cacheB.get("part.shared-key")).toEqual({ secret: "other owner" });
  });

  it("propagates readMany capacity errors so callers can shrink a window", async () => {
    const repo = repository("cache-batch-owner");
    const cache = new DossierAnalysisCache(repo);
    const original = repo.readMany.bind(repo);
    const calls: string[][] = [];
    vi.spyOn(repo, "readMany").mockImplementation(async (kind, ids, options) => {
      calls.push(ids);
      if (ids.length > 1)
        throw new DossierError("CORPUS_CAPACITY_LIMIT", 413);
      return original(kind, ids, options);
    });
    await expect(
      cache.preload(Array.from({ length: 8 }, (_, index) => `part.${index}`)),
    ).rejects.toMatchObject({ code: "CORPUS_CAPACITY_LIMIT" });
    expect(calls).toEqual([
      Array.from({ length: 8 }, (_, index) => `part.${index}`),
    ]);
  });

  it("shrinks extraction prefetch windows when their combined cache is too large", async () => {
    const preloadSizes: number[] = [];
    let modelCalls = 0;
    const model: ModelProvider = {
      id: "prefetch-window-model",
      async generate() {
        modelCalls++;
        return { summary: "source", requirements: [], conflicts: [] };
      },
    };
    const chunk = {
      documentVersionId: "long-source",
      section: "long section",
      index: 0,
      text: "Source requirement. ".repeat(140),
    };
    await extractRequirements([chunk], model, {
      get: async () => null,
      put: async () => undefined,
      preload: async (keys) => {
        preloadSizes.push(keys.length);
        if (keys.length > 1)
          throw new DossierError("CORPUS_CAPACITY_LIMIT", 413);
      },
    });
    expect(preloadSizes[0]).toBeGreaterThan(1);
    expect(preloadSizes.slice(1).every((size) => size === 1)).toBe(true);
    expect(modelCalls).toBe(preloadSizes.length - 1);
  });

  it("preloads only bounded batches of exact extraction keys", async () => {
    const preloadSizes: number[] = [];
    let modelCalls = 0;
    const chunks = Array.from({ length: 161 }, (_, index) => ({
      documentVersionId: "many-fragments",
      page: index + 1,
      index,
      text: `Requirement text ${index}.`,
    }));
    await extractRequirements(
      chunks,
      {
        id: "many-fragment-model",
        async generate() {
          modelCalls++;
          return { summary: "source", requirements: [], conflicts: [] };
        },
      },
      {
        get: async () => null,
        put: async () => undefined,
        preload: async (keys) => {
          preloadSizes.push(keys.length);
        },
      },
    );
    expect(preloadSizes).toEqual([80, 80, 1]);
    expect(modelCalls).toBe(161);
  });
});
