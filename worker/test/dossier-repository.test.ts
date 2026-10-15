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
