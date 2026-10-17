import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { init } from "@flue/runtime";
import { TenderStudy } from "./agents/tender-study";
import backend from "./index";
import { DossierRepository, type Job } from "./dossier/repository";
import { PRIVATE_SCOPES, privateContextSchema } from "./dossier/contracts";
import { runClaimedJob } from "./dossier/jobs";
import { executeProcessingJob, type ProcessingEnv } from "./dossier/processing";
import {
  agentScopeId,
  readStudyJob,
  assertStudyCompleted,
} from "./dossier/agent-scope";
import type { ChatInput } from "./dossier/conversations";
export class SecopDossierWorkflow extends WorkflowEntrypoint<
  ProcessingEnv,
  { ownerId: string; jobId: string }
> {
  async run(
    event: WorkflowEvent<{ ownerId: string; jobId: string }>,
    step: WorkflowStep,
  ) {
    const payload = event.payload;
    const owner = privateContextSchema.parse({
      ownerId: payload.ownerId,
      scopes: [...PRIVATE_SCOPES],
    });
    const repo = new DossierRepository(this.env, owner);
    const claimed = await step.do("claim saved job", async () => {
      const j = await repo.claimJob(payload.jobId);
      return j ? { ...j, progress: JSON.stringify(j.progress) } : null;
    });
    const job: Job | null = claimed
      ? { ...claimed, progress: JSON.parse(claimed.progress) }
      : null;
    if (!job) return { skipped: true };
    await runClaimedJob(repo, job, async (r, j) => {
      if (j.kind !== "chat") {
        await step.do(
          `process ${j.kind}`,
          {
            timeout: "15 minutes",
            retries: { limit: 0, delay: "1 second", backoff: "constant" },
          },
          () => executeProcessingJob(r, j, this.env),
        );
        return;
      }
      const request = (await r.read<ChatInput>("message", j.targetId)).value;
      const seed = { ownerId: owner.ownerId, dossierId: request.dossierId };
      const id = await agentScopeId(seed.ownerId, seed.dossierId);
      j.progress = {
        ...j.progress,
        agentFailure: null,
        agentId: id,
        workflowId: event.instanceId,
      };
      await r.checkpointJob(j.id, j.lease!, j.progress);
      const scope = {
        dossierId: seed.dossierId,
        jobId: j.id,
        lease: j.lease!,
        companyProfileId: request.companyProfileId,
      };
      await readStudyJob(r, scope);
      const agent = init(TenderStudy, { id });
      const receipt = await step.do("dispatch scoped agent", () =>
        agent.dispatch({
          initialData: seed,
          idempotencyKey: `${j.id}:${j.lease}`,
          message: {
            kind: "signal",
            type: "secop.study",
            body: "Study the current saved request with its verified sources.",
            attributes: {
              jobId: j.id,
              lease: j.lease!,
              companyProfileId: request.companyProfileId ?? "",
            },
          },
        }),
      );
      await step.do(
        "read admitted agent reply",
        {
          timeout: "15 minutes",
          retries: { limit: 1, delay: "2 seconds", backoff: "constant" },
        },
        async () => {
          await agent.read(receipt);
          return { settled: true };
        },
      );
      const current = await r.readJob(j.id);
      assertStudyCompleted(current);
    });
    return { jobId: job.id, state: (await repo.readJob(job.id)).state };
  }
}
export default { scheduled: backend.scheduled, queue: backend.queue };
