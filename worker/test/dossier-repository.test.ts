import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { executeProcessingJob } from "../src/dossier/processing";
import { processJob } from "../src/dossier/jobs";
import { DossierError } from "../src/dossier/contracts";
import { vi } from "vitest";
import { DossierRepository } from "../src/dossier/repository";
let mf: Miniflare;
let env: any;
let a: DossierRepository, b: DossierRepository;
let now = 1000000;
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
  env = {
    DOSSIER_DB: await mf.getD1Database("DOSSIER_DB"),
    DOSSIER_FILES: await mf.getR2Bucket("DOSSIER_FILES"),
  };
  await env.DOSSIER_DB.exec(
    readFileSync(
      new URL("../migrations/0001_dossiers.sql", import.meta.url),
      "utf8",
    ),
  );
  a = new DossierRepository(
    env,
    { ownerId: "a", scopes: ["dossier:read", "dossier:write"] },
    () => now,
  );
  b = new DossierRepository(
    env,
    { ownerId: "b", scopes: ["dossier:read", "dossier:write"] },
    () => now,
  );
});
afterAll(async () => {
  await mf?.dispose();
});
describe("persisted owner scoped dossiers and jobs", () => {
  it("retries a transient D1 network loss while checkpointing a job", async () => {
    let runs = 0;
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            runs++;
            if (runs === 1)
              throw new Error("D1_ERROR: Network connection lost");
            return { meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;
    const repo = new DossierRepository(
      { DOSSIER_DB: db, DOSSIER_FILES: env.DOSSIER_FILES },
      a.context,
      () => now,
    );

    await repo.checkpointJob("job-transient", "lease-transient", {
      stage: "extracting_requirements",
      fragmentsVisited: 80,
    });

    expect(runs).toBe(2);
  });

  it("does not retry or mask lease loss during checkpointing", async () => {
    let runs = 0;
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            runs++;
            return { meta: { changes: 0 } };
          },
        }),
      }),
    } as unknown as D1Database;
    const repo = new DossierRepository(
      { DOSSIER_DB: db, DOSSIER_FILES: env.DOSSIER_FILES },
      a.context,
      () => now,
    );

    await expect(
      repo.checkpointJob("job-lost", "stale-lease", { stage: "reviewing" }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });

    expect(runs).toBe(1);
  });

  it("dispatches newly persisted jobs promptly while retaining failed sends for recovery", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValue(undefined);
    const immediate = new DossierRepository(
      { ...env, DOSSIER_QUEUE: { send } },
      a.context,
      () => now,
    );
    const first = await immediate.enqueueJob({
      kind: "inventory",
      targetId: "fast",
      key: "fast-failure",
    });
    expect(send).toHaveBeenCalledWith({ ownerId: "a", jobId: first.id });
    expect((await a.readJob(first.id)).state).toBe("queued");
    await immediate.enqueueJob({
      kind: "inventory",
      targetId: "fast2",
      key: "fast-success",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("dispatches a resumed terminal synthesis using its existing job id", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const immediate = new DossierRepository(
      { ...env, DOSSIER_QUEUE: { send } },
      a.context,
      () => now,
    );
    const original = await a.enqueueJob({
      kind: "synthesize",
      targetId: "resume-synthesis",
      key: "resume-synthesis:1",
    });
    await env.DOSSIER_DB
      .prepare("UPDATE dossier_jobs SET state='failed',error='FAILED' WHERE owner_id=? AND id=?")
      .bind("a", original.id)
      .run();

    const resumed = await immediate.enqueueJob({
      kind: "synthesize",
      targetId: "resume-synthesis",
      key: "resume-synthesis:1",
      resumeTerminalSynthesis: true,
    });

    expect(resumed).toMatchObject({ id: original.id, state: "queued" });
    expect(send).toHaveBeenCalledWith({ ownerId: "a", jobId: original.id });
  });
  it("continues bounded model attempts without exhausting failure retries", async () => {
    const job = await a.enqueueJob({
      kind: "synthesize",
      targetId: "d1",
      key: "yield-test",
    });
    await processJob(env, { ownerId: "a", jobId: job.id }, async () => {
      throw new DossierError("MODEL_BUDGET_EXCEEDED", 429);
    });
    const yielded = await a.readJob(job.id);
    expect(yielded.state).toBe("queued");
    expect(yielded.attempts).toBe(0);
    expect(yielded.progress.stage).toBe("continuing");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    try {
      await processJob(env, { ownerId: "a", jobId: job.id }, async () => {});
      expect((await a.readJob(job.id)).state).toBe("succeeded");
    } finally {
      clock.mockRestore();
    }
  });

  it.each([false, true])(
    "dispatches model continuations promptly and retains the outbox if send fails (%s)",
    async (sendFails) => {
      const send = vi.fn();
      if (sendFails) send.mockRejectedValue(new Error("queue unavailable"));
      else send.mockResolvedValue(undefined);
      const job = await a.enqueueJob({
        kind: "synthesize",
        targetId: "prompt-continuation",
        key: `prompt-continuation:${sendFails}`,
      });
      await processJob(
        { ...env, DOSSIER_QUEUE: { send } },
        { ownerId: "a", jobId: job.id },
        async () => { throw new DossierError("MODEL_BUDGET_EXCEEDED", 429); },
      );
      expect(send).toHaveBeenCalledWith(
        { ownerId: "a", jobId: job.id },
        { delaySeconds: 1 },
      );
      const saved = await a.readJob(job.id);
      expect(saved).toMatchObject({
        state: "queued", attempts: 0, error: null,
        progress: { stage: "continuing" },
      });
      const queued = await env.DOSSIER_DB.prepare(
        "SELECT available_at,dispatched_at FROM dossier_jobs WHERE owner_id=? AND id=?",
      ).bind("a", job.id).first();
      expect(saved.progress.resumeAt).toEqual(queued.available_at);
      expect(queued.dispatched_at).toBeNull();
    },
  );

  it.each(["OCR_CONTINUING", "OCR_BUSY"])(
    "yields %s without consuming document failure retries",
    async (code) => {
      const job = await a.enqueueJob({
        kind: "extract",
        targetId: "long-pdf",
        key: `yield-${code}`,
      });
      await processJob(
        env,
        { ownerId: "a", jobId: job.id },
        async (repo, claimed) => {
          await repo.checkpointJob(claimed.id, claimed.lease!, {
            extractedPages: 5,
            pageCount: 23,
          });
          throw new DossierError(code, 202, true);
        },
      );
      const yielded = await a.readJob(job.id);
      expect(yielded.state).toBe("queued");
      expect(yielded.attempts).toBe(0);
      expect(yielded.error).toBeNull();
      expect(yielded.progress).toMatchObject({
        extractedPages: 5,
        pageCount: 23,
        stage: code === "OCR_BUSY" ? "waiting_ocr" : "ocr_pages",
      });
    },
  );

  it("resumes real owner-scoped R2 batches without publishing partial document evidence", async () => {
    const dossierId = "CO1.REQ.400";
    const documentId = "ocr-integration-document";
    await a.save(
      "dossier",
      dossierId,
      { corpusRevision: 1, documentIds: [documentId] },
      0,
    );
    await a.putFile(
      documentId,
      new TextEncoder().encode("%PDF-integration"),
      "application/pdf",
    );
    await a.save(
      "document",
      documentId,
      { dossierId, name: "scan.pdf", state: "pending", fileId: documentId },
      0,
    );
    const starts: number[] = [];
    const continueOcr = vi.fn().mockResolvedValue(undefined);
    const processingEnv = {
      ...env,
      DOSSIER_QUEUE: { send: continueOcr },
      AI: { toMarkdown: async () => ({ format: "error" }) },
      SECOP_OCR: {
        fetch: async (request: Request) => {
          const start = Number(request.headers.get("x-ocr-start-page"));
          starts.push(start);
          const end = Math.min(start + 4, 7);
          return Response.json({
            parserVersion: "test-ocr",
            pageCount: 7,
            startPage: start,
            endPage: end,
            nextPage: end === 7 ? null : end + 1,
            complete: end === 7,
            warnings: [],
            pages: Array.from({ length: end - start + 1 }, (_, i) => ({
              page: start + i,
              text: `Original source page ${start + i}`,
            })),
          });
        },
      },
    };
    const job = await a.enqueueJob({
      kind: "extract",
      targetId: documentId,
      key: "ocr-integration",
    });
    await processJob(
      processingEnv,
      { ownerId: "a", jobId: job.id },
      (repo, saved) => executeProcessingJob(repo, saved, processingEnv),
    );
    expect(continueOcr).toHaveBeenCalledWith(
      { ownerId: "a", jobId: job.id },
      { delaySeconds: 1 },
    );
    expect((await a.readJob(job.id)).progress).toMatchObject({
      extractedPages: 5,
      pageCount: 7,
      stage: "ocr_pages",
    });
    expect((await a.read<any>("document", documentId)).value.state).toBe(
      "pending",
    );
    expect(
      (await a.all<any>("chunk")).filter(
        (c) => c.value.documentVersionId === documentId,
      ),
    ).toHaveLength(0);
    const cacheId = `ocr-pages-v1.${documentId}`;
    expect(
      JSON.parse(await (await a.getFile(cacheId))!.text()).pages,
    ).toHaveLength(5);
    expect(await b.getFile(cacheId)).toBeNull();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    try {
      await processJob(
        processingEnv,
        { ownerId: "a", jobId: job.id },
        (repo, saved) => executeProcessingJob(repo, saved, processingEnv),
      );
    } finally {
      clock.mockRestore();
    }
    expect(starts).toEqual([1, 6]);
    expect((await a.readJob(job.id)).state).toBe("succeeded");
    expect((await a.read<any>("document", documentId)).value.state).toBe(
      "review_required",
    );
    expect(
      (await a.all<any>("chunk"))
        .filter((c) => c.value.documentVersionId === documentId)
        .map((c) => c.value.page)
        .sort((x, y) => x - y),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("deduplicates dossiers and denies record/file access across owners", async () => {
    const d = await a.createOrGetDossier("CO1.REQ.123");
    expect((await a.createOrGetDossier("CO1.REQ.123")).id).toBe(d.id);
    await expect(b.readDossier(d.id)).rejects.toThrow();
    await a.putFile(
      "document-v1",
      new TextEncoder().encode("evidence"),
      "text/plain",
    );
    expect(await (await a.getFile("document-v1"))!.text()).toBe("evidence");
    expect(await b.getFile("document-v1")).toBeNull();
  });
  it("enforces optimistic revisions and stable owner-scoped lists", async () => {
    await a.save("company", "c1", { name: "Acme" }, 0);
    await expect(
      a.save("company", "c1", { name: "Other" }, 0),
    ).rejects.toThrow();
    expect((await a.list("company")).length).toBe(1);
    expect((await b.list("company")).length).toBe(0);
  });
  it("reads batches in request order without crossing owners and rejects missing rows", async () => {
    await a.save("company", "batch-first", { name: "A first" }, 0);
    await a.save("company", "batch-second", { name: "A second" }, 0);
    await b.save("company", "batch-first", { name: "B first" }, 0);
    await b.save("company", "only-b", { name: "B private" }, 0);

    expect(
      (
        await a.readMany<{ name: string }>("company", [
          "batch-second",
          "batch-first",
        ])
      ).map((record) => record.value.name),
    ).toEqual(["A second", "A first"]);
    expect(
      (await b.readMany<{ name: string }>("company", ["batch-first"]))[0].value
        .name,
    ).toBe("B first");
    await expect(a.readMany("company", ["only-b"])).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("chunks bounded bulk reads and preserves every requested record", async () => {
    const ids = Array.from({ length: 213 }, (_, index) => `batch-${index}`);
    const documents = Array.from({ length: 11 }, (_, index) => `doc-${index}`);
    const statements = [
      ...ids.map((id) =>
        env.DOSSIER_DB.prepare(
          "INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) VALUES(?,?,?,1,?,?)",
        ).bind("a", "company", id, JSON.stringify({ id }), now),
      ),
      ...documents.map((id) =>
        env.DOSSIER_DB.prepare(
          "INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) VALUES(?,?,?,1,?,?)",
        ).bind("a", "document", id, JSON.stringify({ id }), now),
      ),
    ];
    for (let offset = 0; offset < statements.length; offset += 80)
      await env.DOSSIER_DB.batch(statements.slice(offset, offset + 80));

    let queryCount = 0;
    const db = new Proxy(env.DOSSIER_DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "prepare")
          return (...args: Parameters<D1Database["prepare"]>) => {
            queryCount++;
            return value.apply(target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const counted = new DossierRepository(
      { ...env, DOSSIER_DB: db },
      a.context,
    );

    const records = await counted.readMany<{ id: string }>("company", ids);
    const loadedDocuments = await counted.readMany<{ id: string }>(
      "document",
      documents,
    );
    expect(records.map((record) => record.value.id)).toEqual(ids);
    expect(loadedDocuments.map((record) => record.value.id)).toEqual(documents);
    expect(queryCount).toBe(4);
  });

  it("spills large report records to owner-scoped content-addressed R2 and hydrates every read path", async () => {
    const report = {
      dossierId: "CO1.REQ.LARGE",
      hash: "large-report-hash",
      summary: "complete report",
      payload: "á".repeat(600_000),
    };
    const stored = await a.save("report", "large-report", report, 0);

    expect(stored.value).toEqual(report);
    expect(
      (await a.read<typeof report>("report", "large-report")).value,
    ).toEqual(report);
    expect(
      (await a.readMany<typeof report>("report", ["large-report"]))[0].value,
    ).toEqual(report);
    expect(
      (await a.list<typeof report>("report")).find(
        (r) => r.id === "large-report",
      )?.value,
    ).toEqual(report);
    expect(
      (await a.allMatching<typeof report>("report", "hash", [report.hash])).map(
        (r) => r.value,
      ),
    ).toEqual([report]);
    expect(
      (
        await a.allMatching<typeof report>("report", "dossierId", [
          report.dossierId,
        ])
      ).map((r) => r.value),
    ).toEqual([report]);
    await expect(b.read("report", "large-report")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const raw = (await env.DOSSIER_DB.prepare(
      "SELECT value FROM dossier_records WHERE owner_id=? AND kind='report' AND id=?",
    )
      .bind("a", "large-report")
      .first()) as { value: string } | null;
    const pointer = JSON.parse(raw!.value);
    expect(pointer.payload).toBeUndefined();
    expect(pointer.__saviaAggregateBlob.key).toMatch(
      /^report-v1\.[a-f0-9]{64}$/,
    );
    expect(pointer.__saviaAggregateBlob.length).toBe(
      new TextEncoder().encode(JSON.stringify(report)).length,
    );

    await env.DOSSIER_DB.prepare(
      "INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) VALUES(?,?,?,1,?,?)",
    )
      .bind(
        "b",
        "report",
        "forged-report-pointer",
        JSON.stringify(pointer),
        now,
      )
      .run();
    await expect(
      b.read("report", "forged-report-pointer"),
    ).rejects.toMatchObject({ code: "AGGREGATE_BLOB_MISSING" });
  });

  it("fails closed when a spilled report blob is missing or has been tampered with", async () => {
    await a.save(
      "report",
      "missing-report",
      { payload: "m".repeat(600_000) },
      0,
    );
    await a.save(
      "report",
      "tampered-report",
      { payload: "t".repeat(600_000) },
      0,
    );
    const rows = (await env.DOSSIER_DB.prepare(
      "SELECT id,value FROM dossier_records WHERE owner_id=? AND kind='report' AND id IN (?,?)",
    )
      .bind("a", "missing-report", "tampered-report")
      .all()) as { results: { id: string; value: string }[] };
    const pointers = new Map<string, { key: string; length: number }>(
      rows.results.map((row) => {
        const pointer = JSON.parse(row.value).__saviaAggregateBlob;
        return [row.id, { key: pointer.key, length: pointer.length }];
      }),
    );
    await a.deleteFile(pointers.get("missing-report")!.key);
    await a.putFile(
      pointers.get("tampered-report")!.key,
      new TextEncoder().encode(
        "z".repeat(pointers.get("tampered-report")!.length),
      ),
      "application/json",
    );

    await expect(a.read("report", "missing-report")).rejects.toMatchObject({
      code: "AGGREGATE_BLOB_MISSING",
    });
    await expect(a.read("report", "tampered-report")).rejects.toMatchObject({
      code: "AGGREGATE_BLOB_CORRUPT",
    });
  });

  it("keeps large report writes revision-checked and preserves the nonreport record limit", async () => {
    const original = { payload: "original".repeat(80_000) };
    await a.save("report", "revisioned-report", original, 0);
    await expect(
      a.save(
        "report",
        "revisioned-report",
        { payload: "stale".repeat(80_000) },
        0,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      (await a.read<typeof original>("report", "revisioned-report")).value,
    ).toEqual(original);
    await expect(
      a.save(
        "company",
        "too-large-company",
        { payload: "x".repeat(500_001) },
        0,
      ),
    ).rejects.toMatchObject({ code: "RECORD_TOO_LARGE" });
    const expandedReport = { dossierId: "CO1.REQ.500", payload: "x".repeat(20_000_000) };
    const readDuringSave = vi.spyOn(a, "read");
    await a.save("report", "expanded-report", expandedReport, 0);
    expect(readDuringSave).not.toHaveBeenCalled();
    readDuringSave.mockRestore();
    expect((await a.read<typeof expandedReport>("report", "expanded-report")).value)
      .toEqual(expandedReport);
    const readDuringUpsert = vi.spyOn(a, "read");
    expect((await a.upsert("report", "expanded-report", expandedReport)).revision)
      .toBe(2);
    expect(readDuringUpsert).not.toHaveBeenCalled();
    readDuringUpsert.mockRestore();
    const pointerRow = await env.DOSSIER_DB.prepare(
      "SELECT value FROM dossier_records WHERE owner_id=? AND kind='report' AND id=?",
    ).bind("a", "expanded-report").first() as { value: string } | null;
    const pointer = JSON.parse(pointerRow!.value).__saviaAggregateBlob;
    expect(pointer).toMatchObject({ version: 2, kind: "report" });
    expect(pointer.parts.length).toBeGreaterThan(1);
    expect((await a.readMany<typeof expandedReport>("report", ["expanded-report"]))[0].value)
      .toEqual(expandedReport);
    await a.putFile(
      pointer.parts[1].key,
      new TextEncoder().encode("z".repeat(pointer.parts[1].length)),
      "application/json",
    );
    await expect(a.read("report", "expanded-report")).rejects.toMatchObject({
      code: "AGGREGATE_BLOB_CORRUPT",
    });
    await a.deleteFile(pointer.parts[0].key);
    await expect(a.read("report", "expanded-report")).rejects.toMatchObject({
      code: "AGGREGATE_BLOB_MISSING",
    });
    await expect(
      a.save("assessment", "oversized-assessment", { payload: "x".repeat(20_000_000) }, 0),
    ).rejects.toMatchObject({ code: "RECORD_TOO_LARGE" });
  });

  it("spills large assessments with the same owner-scoped integrity checks", async () => {
    const assessment = {
      assessmentId: "assessment-large",
      dossierId: "CO1.REQ.ASSESSMENT",
      findings: "assessment finding ".repeat(40_000),
    };
    await a.save("assessment", assessment.assessmentId, assessment, 0);
    expect(
      (await a.read<typeof assessment>("assessment", assessment.assessmentId))
        .value,
    ).toEqual(assessment);
    expect(
      (
        await a.allMatching<typeof assessment>("assessment", "assessmentId", [
          assessment.assessmentId,
        ])
      ).map((r) => r.value),
    ).toEqual([assessment]);
    expect(
      (
        await a.allMatching<typeof assessment>("assessment", "dossierId", [
          assessment.dossierId,
        ])
      ).map((r) => r.value),
    ).toEqual([assessment]);
    await expect(
      b.read("assessment", assessment.assessmentId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("loads only owner-scoped analysis cache records and excludes finalized reports", async () => {
    await a.save("report", "part.cache-a", { summary: "part a" }, 0);
    await a.save("report", "joint.cache-a", { summary: "joint a" }, 0);
    await a.save("report", "CO1.REQ.500:1", { summary: "final report" }, 0);
    await b.save("report", "part.cache-a", { summary: "other owner" }, 0);

    const cache = await a.readAnalysisCache();
    expect(cache.map((record) => record.id)).toEqual([
      "joint.cache-a",
      "part.cache-a",
    ]);
    expect(cache.map((record) => record.value)).toEqual([
      { summary: "joint a" },
      { summary: "part a" },
    ]);
  });

  it("caps analysis-cache reads before loading more than 5,000 cache records", async () => {
    const db = new Proxy(env.DOSSIER_DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "prepare")
          return (...args: Parameters<D1Database["prepare"]>) => {
            const statement = value.apply(target, args);
            if (String(args[0]).includes("substr(id,1,5)='part.'"))
              return {
                bind: () => ({
                  all: async () => ({
                    results: Array.from({ length: 5001 }, (_, index) => ({
                      id: `part.cache-${index}`,
                    })),
                  }),
                }),
              };
            return statement;
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const capped = new DossierRepository({ ...env, DOSSIER_DB: db }, a.context);
    await expect(capped.readAnalysisCache()).rejects.toMatchObject({
      code: "REPORT_CACHE_CAPACITY_LIMIT",
    });
  });

  it("upserts requirement rows in bounded D1 batches with per-row revisions", async () => {
    const existing = Array.from({ length: 2 }, (_, index) => ({
      id: `batch-requirement-${index}`,
      value: { wording: `old ${index}` },
    }));
    for (const entry of existing)
      await a.save("requirement", entry.id, entry.value, 0);
    const entries = Array.from({ length: 213 }, (_, index) => ({
      id: `batch-requirement-${index}`,
      value: { wording: `new ${index}` },
    }));

    let batchCalls = 0;
    const db = new Proxy(env.DOSSIER_DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "batch")
          return (...args: Parameters<D1Database["batch"]>) => {
            batchCalls++;
            return value.apply(target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const batched = new DossierRepository(
      { ...env, DOSSIER_DB: db },
      a.context,
    );
    await batched.upsertMany("requirement", entries);

    expect(batchCalls).toBe(3);
    const saved = await a.readMany<{ wording: string }>(
      "requirement",
      entries.map((entry) => entry.id),
    );
    expect(saved.map((record) => record.value.wording)).toEqual(
      entries.map((entry) => entry.value.wording),
    );
    expect(saved.slice(0, 2).map((record) => record.revision)).toEqual([2, 2]);
    expect(saved.slice(2).every((record) => record.revision === 1)).toBe(true);
    expect(
      (
        await b.readMany(
          "requirement",
          entries.map((entry) => entry.id),
          { allowMissing: true },
        )
      ).length,
    ).toBe(0);
  });

  it("detects an upsert revision race without overwriting the concurrent value", async () => {
    await a.save("requirement", "batch-race", { wording: "original" }, 0);
    const db = new Proxy(env.DOSSIER_DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "batch")
          return async (...args: Parameters<D1Database["batch"]>) => {
            await target
              .prepare(
                "UPDATE dossier_records SET value=?,revision=revision+1 WHERE owner_id=? AND kind=? AND id=?",
              )
              .bind(
                JSON.stringify({ wording: "concurrent" }),
                "a",
                "requirement",
                "batch-race",
              )
              .run();
            return value.apply(target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racing = new DossierRepository({ ...env, DOSSIER_DB: db }, a.context);

    await expect(
      racing.upsertMany("requirement", [
        { id: "batch-race", value: { wording: "stale write" } },
      ]),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      (await a.read<{ wording: string }>("requirement", "batch-race")).value,
    ).toEqual({ wording: "concurrent" });
  });

  it("bounds bulk requirement writes by count, individual record size and total bytes", async () => {
    await expect(
      a.upsertMany(
        "requirement",
        Array.from({ length: 5001 }, (_, index) => ({
          id: `too-many-${index}`,
          value: { wording: "x" },
        })),
      ),
    ).rejects.toMatchObject({ code: "INVALID_BATCH" });
    await expect(
      a.upsertMany("requirement", [
        { id: "too-large", value: { wording: "x".repeat(500_001) } },
      ]),
    ).rejects.toMatchObject({ code: "RECORD_TOO_LARGE" });
    await expect(
      a.upsertMany(
        "requirement",
        Array.from({ length: 42 }, (_, index) => ({
          id: `too-many-bytes-${index}`,
          value: { wording: "x".repeat(480_000) },
        })),
      ),
    ).rejects.toMatchObject({ code: "CORPUS_CAPACITY_LIMIT" });
  });

  it("atomically commits and hydrates a multi-megabyte conversation message", async () => {
    const conversation = {
      pending: { key: "large-turn-key" },
      turnIds: [],
    };
    await a.save("conversation", "large-conversation", conversation, 0);
    const turn = {
      conversationId: "large-conversation",
      dossierId: "CO1.REQ.LARGE-MESSAGE",
      text: "Complete evidence-grounded answer. ".repeat(70_000),
    };
    const updated = await a.commitConversationTurn(
      "large-conversation",
      1,
      "large-turn-key",
      "large-turn-message",
      turn,
      { turnIds: ["large-turn-message"] },
    );

    expect(updated.value).toEqual({ turnIds: ["large-turn-message"] });
    expect(
      (await a.read<typeof turn>("message", "large-turn-message")).value,
    ).toEqual(turn);
    expect(
      (await a.readMany<typeof turn>("message", ["large-turn-message"]))[0]
        .value,
    ).toEqual(turn);
    expect(
      (await a.list<typeof turn>("message")).find(
        (r) => r.id === "large-turn-message",
      )?.value,
    ).toEqual(turn);
    expect(
      (
        await a.allMatching<typeof turn>("message", "dossierId", [
          turn.dossierId,
        ])
      ).map((r) => r.value),
    ).toEqual([turn]);
    const raw = (await env.DOSSIER_DB.prepare(
      "SELECT value FROM dossier_records WHERE owner_id=? AND kind='message' AND id=?",
    )
      .bind("a", "large-turn-message")
      .first()) as { value: string } | null;
    const pointer = JSON.parse(raw!.value);
    expect(pointer.__saviaAggregateBlob.key).toMatch(
      /^message-v1\.[a-f0-9]{64}$/,
    );
    expect(pointer.conversationId).toBe("large-conversation");
    expect(pointer.text).toBeUndefined();
    await env.DOSSIER_DB.prepare(
      "INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) VALUES(?,?,?,1,?,?)",
    )
      .bind(
        "b",
        "message",
        "forged-message-pointer",
        JSON.stringify(pointer),
        now,
      )
      .run();
    await expect(
      b.read("message", "forged-message-pointer"),
    ).rejects.toMatchObject({ code: "AGGREGATE_BLOB_MISSING" });
  });

  it("keeps small conversation turns inline and commits them atomically", async () => {
    await a.save(
      "conversation",
      "small-conversation",
      { pending: { key: "small-turn-key" }, turnIds: [] },
      0,
    );
    const turn = { conversationId: "small-conversation", answer: "ready" };
    await a.commitConversationTurn(
      "small-conversation",
      1,
      "small-turn-key",
      "small-turn-message",
      turn,
      { turnIds: ["small-turn-message"] },
    );
    expect((await a.read("message", "small-turn-message")).value).toEqual(turn);
    const raw = (await env.DOSSIER_DB.prepare(
      "SELECT value FROM dossier_records WHERE owner_id=? AND kind='message' AND id=?",
    )
      .bind("a", "small-turn-message")
      .first()) as { value: string } | null;
    expect(JSON.parse(raw!.value)).toEqual(turn);
  });

  it("does not publish a dangling large message or oversized conversation on a stale commit", async () => {
    const conversation = {
      pending: { key: "current-turn-key" },
      turnIds: [],
    };
    await a.save("conversation", "stale-conversation", conversation, 0);
    const turn = {
      conversationId: "stale-conversation",
      text: "stale result ".repeat(180_000),
    };
    await expect(
      a.commitConversationTurn(
        "stale-conversation",
        1,
        "outdated-turn-key",
        "dangling-turn-message",
        turn,
        { turnIds: ["dangling-turn-message"] },
      ),
    ).rejects.toMatchObject({ code: "CONVERSATION_LEASE_LOST" });
    await expect(
      a.read("message", "dangling-turn-message"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await a.read("conversation", "stale-conversation")).value).toEqual(
      conversation,
    );

    await expect(
      a.commitConversationTurn(
        "stale-conversation",
        1,
        "current-turn-key",
        "oversized-conversation-turn",
        { text: "small turn" },
        { text: "x".repeat(500_001) },
      ),
    ).rejects.toMatchObject({ code: "RECORD_TOO_LARGE" });
    await expect(
      a.read("message", "oversized-conversation-turn"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await a.read("conversation", "stale-conversation")).value).toEqual(
      conversation,
    );
  });

  it("supports outbox recovery, exclusive claims, renewal, retry and cancellation", async () => {
    const j = await a.enqueueJob({
      kind: "inventory",
      targetId: "d1",
      key: "corpus-1",
    });
    expect(
      (
        await a.enqueueJob({
          kind: "inventory",
          targetId: "d1",
          key: "corpus-1",
        })
      ).id,
    ).toBe(j.id);
    expect((await a.listDispatchableJobs()).some((x) => x.id === j.id)).toBe(
      true,
    );
    await expect(b.readJob(j.id)).rejects.toThrow();
    const claims = await Promise.all([a.claimJob(j.id), a.claimJob(j.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    await a.checkpointJob(j.id, claim.lease!, { page: 2 });
    now += 120001;
    const renewed = await a.claimJob(j.id);
    expect(renewed).not.toBeNull();
    await expect(a.completeJob(j.id, claim.lease!)).rejects.toThrow();
    await a.failJob(j.id, renewed!.lease!, "UPSTREAM_UNAVAILABLE", true);
    expect((await a.readJob(j.id)).state).toBe("queued");
    now += 120001;
    const final = await a.claimJob(j.id);
    await a.completeJob(j.id, final!.lease!);
    expect(await a.claimJob(j.id)).toBeNull();
    const cancelled = await a.enqueueJob({
      kind: "inventory",
      targetId: "d2",
      key: "cancel",
    });
    await a.cancelJob(cancelled.id);
    expect(await a.claimJob(cancelled.id)).toBeNull();
  });
});
