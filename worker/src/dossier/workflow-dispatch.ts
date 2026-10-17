import { privateContextSchema, PRIVATE_SCOPES } from "./contracts";
import { DossierRepository, type DossierEnv } from "./repository";
import { workflowInstanceId } from "./agent-scope";
export type WorkflowEnv = DossierEnv & {
  DOSSIER_WORKFLOW?: Workflow<{ ownerId: string; jobId: string }>;
};
export async function dispatchWorkflow(
  env: WorkflowEnv,
  message: { ownerId: string; jobId: string },
) {
  const owner = privateContextSchema.parse({
    ownerId: message.ownerId,
    scopes: [...PRIVATE_SCOPES],
  });
  const repo = new DossierRepository(env, owner);
  const job = await repo.readJob(message.jobId);
  if (!["queued", "running"].includes(job.state)) return;
  const id = await workflowInstanceId(owner.ownerId, job);
  if (!env.DOSSIER_WORKFLOW) throw new Error("DOSSIER_WORKFLOW_UNCONFIGURED");
  try {
    await env.DOSSIER_WORKFLOW.create({ id, params: message });
  } catch (error) {
    try {
      const instance = await env.DOSSIER_WORKFLOW.get(id);
      const state = await instance.status();
      if (
        ["errored", "complete", "terminated"].includes(state.status) &&
        (job.state === "queued" ||
          (job.state === "running" && (job.leaseUntil ?? 0) <= repo.now()))
      )
        await instance.restart();
    } catch {
      throw error;
    }
  }
}
