import { processingFailure } from "./jobs";
import { z } from "zod/v4";
import { DossierError, privateContextSchema } from "./contracts";
import { sha256 } from "./downloads";
import type { ChatInput } from "./conversations";
import { DossierRepository, type Job } from "./repository";
export const agentSeedSchema = z
  .object({
    ownerId: privateContextSchema.shape.ownerId,
    dossierId: z.string().min(1).max(180),
  })
  .strict();
export type AgentSeed = z.infer<typeof agentSeedSchema>;
export type StudyScope = {
  dossierId: string;
  jobId: string;
  lease: string;
  companyProfileId?: string;
};
export async function agentScopeId(ownerId: string, dossierId: string) {
  agentSeedSchema.parse({ ownerId, dossierId });
  return sha256(JSON.stringify(["secop-agent-v1", ownerId, dossierId]));
}
export async function workflowInstanceId(ownerId: string, job: Job) {
  return sha256(
    JSON.stringify([
      "secop-workflow-v1",
      ownerId,
      job.id,
      job.attempts,
      job.progress.resumeAt ?? 0,
    ]),
  );
}
export async function readStudyJob(repo: DossierRepository, scope: StudyScope) {
  const job = await repo.readJob(scope.jobId);
  if (job.kind !== "chat")
    throw new DossierError("AGENT_CONTEXT_MISMATCH", 403);
  const request = (await repo.read<ChatInput>("message", job.targetId)).value;
  if (
    request.dossierId !== scope.dossierId ||
    (request.companyProfileId ?? "") !== (scope.companyProfileId ?? "")
  )
    throw new DossierError("AGENT_CONTEXT_MISMATCH", 403);
  if (
    job.state !== "running" ||
    !scope.lease ||
    job.lease !== scope.lease ||
    !job.leaseUntil ||
    job.leaseUntil <= repo.now()
  )
    throw new DossierError("LEASE_LOST", 409);
  await repo.readDossier(scope.dossierId);
  if (scope.companyProfileId)
    await repo.read("company", scope.companyProfileId);
  return { job, request };
}
export async function executeScopedStudy(
  repo: DossierRepository,
  scope: StudyScope,
  execute: (repo: DossierRepository, job: Job) => Promise<void>,
) {
  const { job } = await readStudyJob(repo, scope);
  if (job.progress.stage !== "answered") await execute(repo, job);
  const current = await repo.readJob(job.id);
  if (current.progress.stage !== "answered")
    throw new DossierError("AGENT_STUDY_INCOMPLETE", 502, true);
  return { completed: true, result: current.progress.result ?? null };
}

export async function executeStudyTool(
  repo: DossierRepository,
  scope: StudyScope,
  execute: (repo: DossierRepository, job: Job) => Promise<void>,
) {
  try {
    const { job } = await readStudyJob(repo, scope);
    await repo.checkpointJob(job.id, scope.lease, {
      ...job.progress,
      agentFailure: null,
    });
    return await executeScopedStudy(repo, scope, execute);
  } catch (error) {
    const failure = processingFailure(error);
    if (failure.code === "LEASE_LOST") throw failure;
    // Revalidate authorization and the lease before saving a bounded failure marker.
    const { job } = await readStudyJob(repo, scope);
    await repo.checkpointJob(job.id, scope.lease, {
      ...job.progress,
      agentFailure: {
        code: failure.code,
        status: failure.status,
        retryable: failure.retryable,
      },
    });
    return { completed: false, failure: failure.code };
  }
}
export function assertStudyCompleted(job: Job) {
  const failure = z
    .object({
      code: z.string().max(100),
      status: z.number().int().min(400).max(599),
      retryable: z.boolean(),
    })
    .nullable()
    .optional()
    .parse(job.progress.agentFailure);
  if (failure)
    throw new DossierError(failure.code, failure.status, failure.retryable);
  if (job.progress.stage !== "answered")
    throw new DossierError("AGENT_STUDY_INCOMPLETE", 502, true);
}
