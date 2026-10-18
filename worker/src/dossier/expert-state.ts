import { z } from "zod/v4";
import { DossierError } from "./contracts";
import { sha256 } from "./downloads";
import { readStudyJob, type StudyScope } from "./agent-scope";
import { authorizeExpertActions } from "./expert-policy";
import { DossierRepository, type Stored } from "./repository";
export type ExpertContext = {
  ownerId: string;
  dossierId: string;
  companyProfileId?: string;
};
export type ExpertScope = StudyScope & { ownerId: string };
export const snapshotSchema = z
  .object({
    dossierId: z.string(),
    corpusRevision: z.number().int(),
    reportId: z.string(),
    companyProfileId: z.string().nullable(),
    companyRevision: z.number().int().nullable(),
  })
  .strict();
export type ExpertSnapshot = z.infer<typeof snapshotSchema>;
export const planItemSchema = z
  .object({
    requirementId: z.string().min(1),
    sourceRefs: z
      .array(z.string().regex(/^S\d{3,}$/))
      .min(1)
      .max(30),
    status: z.enum([
      "meets",
      "does_not_meet",
      "insufficient_evidence",
      "not_applicable",
    ]),
    nextAction: z.string().min(1).max(5000),
    owner: z.string().max(200).nullable(),
    dueDate: z.iso.date().nullable(),
  })
  .strict();
export type ExpertPlanItem = z.infer<typeof planItemSchema>;
export const planSchema = z
  .object({
    snapshot: snapshotSchema,
    originatingTurnId: z.string(),
    items: z.array(planItemSchema).max(1000),
  })
  .strict();
export type ExpertPlan = z.infer<typeof planSchema>;
export const memorySchema = z
  .object({
    snapshot: snapshotSchema,
    decisions: z
      .array(
        z.object({ text: z.string().max(8000), originatingTurnId: z.string() }),
      )
      .max(100),
    unresolvedQuestions: z.array(z.string().max(1000)).max(100),
  })
  .strict();
export type ExpertMemory = z.infer<typeof memorySchema>;
export async function expertStateId(context: ExpertContext) {
  return sha256(
    JSON.stringify([
      "expert-state-v1",
      context.ownerId,
      context.dossierId,
      context.companyProfileId ?? null,
    ]),
  );
}
export async function expertSnapshot(
  repo: DossierRepository,
  context: ExpertContext,
): Promise<ExpertSnapshot> {
  if (context.ownerId !== repo.context.ownerId)
    throw new DossierError("AGENT_CONTEXT_MISMATCH", 403);
  const dossier = await repo.readDossier(context.dossierId);
  const company = context.companyProfileId
    ? await repo.read("company", context.companyProfileId)
    : null;
  return {
    dossierId: context.dossierId,
    corpusRevision: Number(dossier.value.corpusRevision),
    reportId: String(dossier.value.reportId ?? ""),
    companyProfileId: context.companyProfileId ?? null,
    companyRevision: company?.revision ?? null,
  };
}
async function optional<T>(
  repo: DossierRepository,
  kind: "expert_plan" | "expert_memory" | "expert_receipt",
  id: string,
): Promise<Stored<T> | null> {
  try {
    return await repo.read<T>(kind, id);
  } catch (e) {
    if (e instanceof DossierError && e.code === "NOT_FOUND") return null;
    throw e;
  }
}
export async function readExpertState(
  repo: DossierRepository,
  context: ExpertContext,
) {
  const snapshot = await expertSnapshot(repo, context),
    id = await expertStateId(context);
  const plan = await optional<ExpertPlan>(repo, "expert_plan", id),
    memory = await optional<ExpertMemory>(repo, "expert_memory", id);
  return {
    plan,
    memory,
    stale: [plan, memory].some(
      (s) =>
        !!s && JSON.stringify(s.value.snapshot) !== JSON.stringify(snapshot),
    ),
  };
}
export async function commitExpertEffect(
  repo: DossierRepository,
  scope: ExpertScope,
  input: {
    operationId: string;
    snapshot: ExpertSnapshot;
    expectedRevision: number;
    kind: "plan" | "memory";
    value: ExpertPlan | ExpertMemory;
  },
) {
  if (scope.ownerId !== repo.context.ownerId)
    throw new DossierError("AGENT_CONTEXT_MISMATCH", 403);
  const { request } = await readStudyJob(repo, scope);
  const action = input.kind === "plan" ? "save_plan" : "remember_decision";
  if (
    !authorizeExpertActions(
      request.message,
      [action],
      request.authority,
    ).includes(action)
  )
    throw new DossierError("EXPERT_ACTION_FORBIDDEN", 403);
  const current = await expertSnapshot(repo, scope),
    value =
      input.kind === "plan"
        ? planSchema.parse(input.value)
        : memorySchema.parse(input.value);
  if (
    JSON.stringify(current) !== JSON.stringify(input.snapshot) ||
    JSON.stringify(current) !== JSON.stringify(value.snapshot)
  )
    throw new DossierError("EXPERT_SNAPSHOT_CHANGED", 409);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.operationId.length > 200 ||
    !input.operationId
  )
    throw new DossierError("INVALID_REQUEST", 422);
  const payload = JSON.stringify(value);
  if (payload.length > 750000)
    throw new DossierError("EXPERT_STATE_CAPACITY", 413);
  const id = await expertStateId(scope),
    kind = input.kind === "plan" ? "expert_plan" : "expert_memory",
    receiptId = await sha256(
      JSON.stringify([id, input.kind, input.operationId]),
    ),
    hash = await sha256(payload);
  type Receipt = { hash: string; id: string; revision: number };
  const existing = await optional<Receipt>(repo, "expert_receipt", receiptId);
  if (existing) {
    if (existing.value.hash !== hash)
      throw new DossierError("IDEMPOTENCY_CONFLICT", 409);
    return {
      id: existing.value.id,
      revision: existing.value.revision,
      duplicate: true,
    };
  }
  const now = repo.now(),
    next = input.expectedRevision + 1;
  // Both statements run atomically in D1. The first reserves only if lease,
  // snapshot and optimistic state revision still match; the second consumes it.
  const guard =
    "EXISTS(SELECT 1 FROM dossier_jobs WHERE owner_id=? AND id=? AND state='running' AND lease=? AND lease_until>?) AND EXISTS(SELECT 1 FROM dossier_records WHERE owner_id=? AND kind='dossier' AND id=? AND json_extract(value,'$.corpusRevision')=? AND json_extract(value,'$.reportId')=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM dossier_records WHERE owner_id=? AND kind='company' AND id=? AND revision=?))";
  const guardArgs = [
    scope.ownerId,
    scope.jobId,
    scope.lease,
    now,
    scope.ownerId,
    scope.dossierId,
    current.corpusRevision,
    current.reportId,
    current.companyProfileId,
    scope.ownerId,
    current.companyProfileId,
    current.companyRevision,
  ];
  const revisionGuard =
    "COALESCE((SELECT revision FROM dossier_records WHERE owner_id=? AND kind=? AND id=?),0)=?";
  const result = await repo.db.batch([
    repo.db
      .prepare(
        `INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) SELECT ?,'expert_receipt',?,1,?,? WHERE ${guard} AND ${revisionGuard} ON CONFLICT DO NOTHING`,
      )
      .bind(
        scope.ownerId,
        receiptId,
        JSON.stringify({ hash, id, revision: next }),
        now,
        ...guardArgs,
        scope.ownerId,
        kind,
        id,
        input.expectedRevision,
      ),
    repo.db
      .prepare(
        `INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM dossier_records WHERE owner_id=? AND kind='expert_receipt' AND id=? AND json_extract(value,'$.hash')=?) AND ${guard} AND ${revisionGuard} ON CONFLICT(owner_id,kind,id) DO UPDATE SET revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at WHERE dossier_records.revision=?`,
      )
      .bind(
        scope.ownerId,
        kind,
        id,
        next,
        payload,
        now,
        scope.ownerId,
        receiptId,
        hash,
        ...guardArgs,
        scope.ownerId,
        kind,
        id,
        input.expectedRevision,
        input.expectedRevision,
      ),
  ]);
  const receipt = await optional<Receipt>(repo, "expert_receipt", receiptId);
  if (!receipt) throw new DossierError("REVISION_CONFLICT", 409);
  if (receipt.value.hash !== hash)
    throw new DossierError("IDEMPOTENCY_CONFLICT", 409);
  return {
    id: receipt.value.id,
    revision: receipt.value.revision,
    duplicate: result[1].meta.changes === 0,
  };
}
