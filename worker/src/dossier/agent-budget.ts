import { DossierError, PRIVATE_SCOPES } from "./contracts";
import { DossierRepository, type DossierEnv } from "./repository";
import { consumeOwnerLimit } from "./limits";
import { readStudyJob } from "./agent-scope";
export async function budgetAgentInference(
  env: DossierEnv & { MODEL_DAILY_LIMIT?: string },
  agentId: string,
) {
  if (!env.DOSSIER_DB) throw new DossierError("DOSSIER_UNCONFIGURED", 503);
  const jobs = await env.DOSSIER_DB.prepare(
    "SELECT owner_id AS ownerId,id FROM dossier_jobs WHERE state='running' AND lease_until>? AND json_extract(progress,'$.agentId')=? LIMIT 2",
  )
    .bind(Date.now(), agentId)
    .all<{ ownerId: string; id: string }>();
  if (jobs.results.length !== 1)
    throw new DossierError("AGENT_CONTEXT_MISMATCH", 403);
  const row = jobs.results[0],
    repo = new DossierRepository(env, {
      ownerId: row.ownerId,
      scopes: [...PRIVATE_SCOPES],
    }),
    job = await repo.readJob(row.id);
  const input = (await repo.read<any>("message", job.targetId)).value;
  await readStudyJob(repo, {
    dossierId: input.dossierId,
    companyProfileId: input.companyProfileId,
    jobId: job.id,
    lease: job.lease!,
  });
  await consumeOwnerLimit(repo, `flue-model:${job.id}`, 8, 86400000);
  await consumeOwnerLimit(
    repo,
    "model-daily",
    Number(env.MODEL_DAILY_LIMIT ?? 1000),
    86400000,
  );
}
