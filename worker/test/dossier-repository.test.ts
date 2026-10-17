import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
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
      (await a.readMany<{ name: string }>("company", [
        "batch-second",
        "batch-first",
      ])).map((record) => record.value.name),
    ).toEqual(["A second", "A first"]);
    expect(
      (await b.readMany<{ name: string }>("company", ["batch-first"]))[0]
        .value.name,
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
    const counted = new DossierRepository({ ...env, DOSSIER_DB: db }, a.context);

    const records = await counted.readMany<{ id: string }>("company", ids);
    const loadedDocuments = await counted.readMany<{ id: string }>(
      "document",
      documents,
    );
    expect(records.map((record) => record.value.id)).toEqual(ids);
    expect(loadedDocuments.map((record) => record.value.id)).toEqual(documents);
    expect(queryCount).toBe(4);
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
