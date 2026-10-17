import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { DossierRepository } from "../src/dossier/repository";
import { dispatchWorkflow } from "../src/dossier/workflow-dispatch";
import { runClaimedJob } from "../src/dossier/jobs";
import { PRIVATE_SCOPES, DossierError } from "../src/dossier/contracts";
import {
  agentScopeId,
  readStudyJob,
  workflowInstanceId,
  executeScopedStudy,
  executeStudyTool,
  assertStudyCompleted,
} from "../src/dossier/agent-scope";
let mf: Miniflare;
let repo: DossierRepository;
let foreign: DossierRepository;
let jobId: string;
let lease: string;
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
  const env: any = {
    DOSSIER_DB: await mf.getD1Database("DOSSIER_DB"),
    DOSSIER_FILES: await mf.getR2Bucket("DOSSIER_FILES"),
  };
  await env.DOSSIER_DB.exec(
    readFileSync(
      new URL("../migrations/0001_dossiers.sql", import.meta.url),
      "utf8",
    ),
  );
  repo = new DossierRepository(env, {
    ownerId: "owner-a",
    scopes: [...PRIVATE_SCOPES],
  });
  foreign = new DossierRepository(env, {
    ownerId: "owner-b",
    scopes: [...PRIVATE_SCOPES],
  });
  await repo.save("dossier", "tender-a", { corpusRevision: 1 }, 0);
  await repo.save(
    "message",
    "request-a",
    {
      dossierId: "tender-a",
      companyProfileId: "company-a",
      message: "Requisitos",
      expectedRevision: 0,
      idempotencyKey: "request-a",
    },
    0,
  );
  await repo.save("company", "company-a", { name: "Company A" }, 0);
  const queued = await repo.enqueueJob({
    kind: "chat",
    targetId: "request-a",
    key: "request-a",
  });
  const job = await repo.claimJob(queued.id);
  jobId = job!.id;
  lease = job!.lease!;
});
afterAll(async () => {
  await mf.dispose();
});
describe("private dossier agent isolation", () => {
  it("uses distinct stable identities for owners and dossiers", async () => {
    const id = await agentScopeId("owner-a", "tender-a");
    expect(id).toBe(await agentScopeId("owner-a", "tender-a"));
    expect(id).not.toBe(await agentScopeId("owner-b", "tender-a"));
    expect(id).not.toBe(await agentScopeId("owner-a", "tender-b"));
  });
  it("accepts only the saved request and current job lease", async () => {
    const result = await readStudyJob(repo, {
      dossierId: "tender-a",
      jobId,
      lease,
      companyProfileId: "company-a",
    });
    expect(result.request.dossierId).toBe("tender-a");
  });
  it("rejects a foreign owner before accessing the request", async () => {
    await expect(
      readStudyJob(foreign, {
        dossierId: "tender-a",
        jobId,
        lease,
        companyProfileId: "company-a",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejects another dossier even for the same owner", async () => {
    await expect(
      readStudyJob(repo, {
        dossierId: "tender-b",
        jobId,
        lease,
        companyProfileId: "company-a",
      }),
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_MISMATCH" });
  });
  it("rejects a changed company selection", async () => {
    await expect(
      readStudyJob(repo, {
        dossierId: "tender-a",
        jobId,
        lease,
        companyProfileId: "company-b",
      }),
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_MISMATCH" });
  });
  it("rejects an expired or substituted lease", async () => {
    await expect(
      readStudyJob(repo, {
        dossierId: "tender-a",
        jobId,
        lease: "other",
        companyProfileId: "company-a",
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  });
  it("deduplicates delivery but gives budget continuations a fresh workflow", async () => {
    const job = await repo.readJob(jobId);
    expect(await workflowInstanceId("owner-a", job)).toBe(
      await workflowInstanceId("owner-a", job),
    );
    expect(await workflowInstanceId("owner-a", job)).not.toBe(
      await workflowInstanceId("owner-b", job),
    );
    expect(await workflowInstanceId("owner-a", job)).not.toBe(
      await workflowInstanceId("owner-a", {
        ...job,
        progress: { resumeAt: 123 },
      }),
    );
  });
  it("reuses a persisted authoritative answer instead of rerunning a duplicate tool", async () => {
    let calls = 0;
    const execute = async (r: DossierRepository, j: any) => {
      calls++;
      await r.checkpointJob(j.id, j.lease, {
        stage: "answered",
        result: { conversationId: "conversation-a" },
      });
    };
    const scope = {
      dossierId: "tender-a",
      jobId,
      lease,
      companyProfileId: "company-a",
    };
    await executeScopedStudy(repo, scope, execute);
    const second = await executeScopedStudy(repo, scope, execute);
    expect(calls).toBe(1);
    expect(second.completed).toBe(true);
  });
  it("acknowledges duplicate workflow delivery only after confirming the instance exists", async () => {
    let creates = 0;
    let reads = 0;
    const env: any = {
      ...repo.env,
      DOSSIER_WORKFLOW: {
        create: async () => {
          creates++;
          throw new Error("already exists");
        },
        get: async () => ({
          status: async () => {
            reads++;
            return { status: "running" };
          },
        }),
      },
    };
    await dispatchWorkflow(env, { ownerId: "owner-a", jobId });
    expect(creates).toBe(1);
    expect(reads).toBe(1);
  });
  it("does not hide an admission failure when no workflow instance exists", async () => {
    const env: any = {
      ...repo.env,
      DOSSIER_WORKFLOW: {
        create: async () => {
          throw new Error("admission unavailable");
        },
        get: async () => {
          throw new Error("not found");
        },
      },
    };
    await expect(
      dispatchWorkflow(env, { ownerId: "owner-a", jobId }),
    ).rejects.toThrow("admission unavailable");
  });
  it("restarts a completed workflow when a saved job is explicitly queued for retry", async () => {
    const queued = await repo.enqueueJob({
      kind: "chat",
      targetId: "request-a",
      key: "manual-retry",
    });
    let restarted = false;
    await dispatchWorkflow(
      {
        ...repo.env,
        DOSSIER_WORKFLOW: {
          create: async () => {
            throw new Error("exists");
          },
          get: async () => ({
            status: async () => ({ status: "complete" }),
            restart: async () => {
              restarted = true;
            },
          }),
        },
      } as any,
      { ownerId: "owner-a", jobId: queued.id },
    );
    expect(restarted).toBe(true);
  });
  it("recovers expired running jobs whose duplicate workflow already completed", async () => {
    const queued = await repo.enqueueJob({
      kind: "chat",
      targetId: "request-a",
      key: "expired-running",
    });
    await repo.claimJob(queued.id);
    await repo.db
      .prepare(
        "UPDATE dossier_jobs SET lease_until=? WHERE owner_id=? AND id=?",
      )
      .bind(repo.now() - 1, "owner-a", queued.id)
      .run();
    let restarted = false;
    await dispatchWorkflow(
      {
        ...repo.env,
        DOSSIER_WORKFLOW: {
          create: async () => {
            throw new Error("exists");
          },
          get: async () => ({
            status: async () => ({ status: "complete" }),
            restart: async () => {
              restarted = true;
            },
          }),
        },
      } as any,
      { ownerId: "owner-a", jobId: queued.id },
    );
    expect(restarted).toBe(true);
  });
  it("preserves processing checkpoints and yields budget failures across the Flue boundary", async () => {
    const queued = await repo.enqueueJob({
      kind: "chat",
      targetId: "request-a",
      key: "agent-budget",
    });
    const claimed = (await repo.claimJob(queued.id))!;
    await runClaimedJob(repo, claimed, async (r, j) => {
      const result = await executeStudyTool(
        r,
        {
          dossierId: "tender-a",
          jobId: j.id,
          lease: j.lease!,
          companyProfileId: "company-a",
        },
        async (r, j) => {
          await r.checkpointJob(j.id, j.lease!, { completedBatches: 3 });
          throw new DossierError("MODEL_BUDGET_EXCEEDED", 429);
        },
      );
      expect(result.completed).toBe(false);
      assertStudyCompleted(await r.readJob(j.id));
    });
    const yielded = await repo.readJob(claimed.id);
    expect(yielded.state).toBe("queued");
    expect(yielded.attempts).toBe(0);
    expect(yielded.progress.stage).toBe("continuing");
    expect(yielded.progress.completedBatches).toBe(3);
    expect(yielded.error).toBeNull();
    expect(yielded.progress.agentFailure).toEqual({
      code: "MODEL_BUDGET_EXCEEDED",
      status: 429,
      retryable: false,
    });
  });
  it("clears a persisted failure if a durable tool is replayed successfully", async () => {
    const queued = await repo.enqueueJob({
      kind: "chat",
      targetId: "request-a",
      key: "agent-replay",
    });
    const job = (await repo.claimJob(queued.id))!;
    const scope = {
      dossierId: "tender-a",
      jobId: job.id,
      lease: job.lease!,
      companyProfileId: "company-a",
    };
    await executeStudyTool(repo, scope, async () => {
      throw new DossierError("MODEL_INVALID_OUTPUT", 502);
    });
    await executeStudyTool(repo, scope, async (r, j) => {
      await r.checkpointJob(j.id, j.lease!, {
        ...j.progress,
        stage: "answered",
      });
    });
    const current = await repo.readJob(job.id);
    expect(() => assertStudyCompleted(current)).not.toThrow();
    expect(current.progress.agentFailure).toBeNull();
  });
  it("rejects an expired lease before running a study", async () => {
    await repo.db
      .prepare(
        "UPDATE dossier_jobs SET lease_until=? WHERE owner_id=? AND id=?",
      )
      .bind(repo.now() - 1, "owner-a", jobId)
      .run();
    await expect(
      readStudyJob(repo, {
        dossierId: "tender-a",
        jobId,
        lease,
        companyProfileId: "company-a",
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  });
});
