import { sha256 } from "./downloads";
import { renderExhaustiveChecklist } from "./checklist";
import { z } from "zod/v4";
import { DossierError } from "./contracts";
import { DossierRepository } from "./repository";
import { readConversation, type Conversation } from "./conversations";
const id = z.string().min(1).max(200);
export const assistantProviderSchema = z
  .object({
    context: z
      .object({
        dossierId: z.string().regex(/^CO1\.REQ\.\d+$/),
        companyProfileId: id.optional(),
      })
      .strict(),
    request: z.discriminatedUnion("method", [
      z.object({ method: z.literal("load") }).strict(),
      z.object({ method: z.literal("poll"), jobId: id }).strict(),
      z
        .object({
          method: z.literal("send"),
          message: z.string().trim().min(1).max(8000),
          idempotencyKey: z.string().min(8).max(100),
          conversationId: id.optional(),
          expectedRevision: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  })
  .strict();
type ProviderInput = z.infer<typeof assistantProviderSchema>;
type QueueChat = (input: Record<string, unknown>) => Promise<unknown>;
export async function runAssistantProvider(
  repo: DossierRepository,
  input: ProviderInput,
  queueChat: QueueChat,
) {
  const { context, request } = input;
  const dossier = await repo.readDossier(context.dossierId);
  const selectedCompany = context.companyProfileId
    ? await repo.read<{ name: string }>("company", context.companyProfileId)
    : null;
  function matches(value: { dossierId?: unknown; companyProfileId?: unknown }) {
    return (
      value.dossierId === context.dossierId &&
      value.companyProfileId === context.companyProfileId
    );
  }
  let pendingJobId: string | undefined;
  let preferredConversationId: string | undefined;
  async function correlate(source: {
    conversationId?: string;
    idempotencyKey?: string;
  }) {
    preferredConversationId =
      source.conversationId ??
      (source.idempotencyKey
        ? await sha256(
            `conversation:${context.dossierId}:${context.companyProfileId ?? ""}:${source.idempotencyKey}`,
          )
        : undefined);
  }
  if (request.method === "send") {
    await correlate(request);
    if (request.conversationId) {
      const c = await repo.read<Conversation>(
        "conversation",
        request.conversationId,
      );
      if (!matches(c.value))
        throw new DossierError("CONVERSATION_CONTEXT_MISMATCH", 403);
    }
    const result = (await queueChat({
      dossierId: context.dossierId,
      ...(context.companyProfileId
        ? { companyProfileId: context.companyProfileId }
        : {}),
      ...(request.conversationId
        ? { conversationId: request.conversationId }
        : {}),
      expectedRevision: request.expectedRevision,
      message: request.message,
      idempotencyKey: request.idempotencyKey,
    })) as { job: { id: string } };
    pendingJobId = result.job.id;
  } else if (request.method === "poll") {
    const job = await repo.readJob(request.jobId);
    if (job.kind !== "chat")
      throw new DossierError("JOB_CONTEXT_MISMATCH", 403);
    const source = await repo.read<{
      dossierId: string;
      companyProfileId?: string;
      conversationId?: string;
      idempotencyKey?: string;
    }>("message", job.targetId);
    await correlate(source.value);
    if (!matches(source.value))
      throw new DossierError("JOB_CONTEXT_MISMATCH", 403);
    if (job.state === "failed")
      throw new DossierError(job.error ?? "CHAT_FAILED", 409, true);
    if (job.state === "cancelled")
      throw new DossierError("CHAT_CANCELLED", 409);
    if (["running", "queued"].includes(job.state)) pendingJobId = job.id;
  }
  if (!pendingJobId && request.method === "load") {
    const pending = await repo.db
      .prepare(
        "SELECT j.id,r.value FROM dossier_jobs j JOIN dossier_records r ON r.owner_id=j.owner_id AND r.kind='message' AND r.id=j.target_id WHERE j.owner_id=? AND j.kind='chat' AND j.state IN ('queued','running') AND json_extract(r.value,'$.dossierId')=? AND COALESCE(json_extract(r.value,'$.companyProfileId'),'')=? ORDER BY j.created_at DESC LIMIT 1",
      )
      .bind(
        repo.context.ownerId,
        context.dossierId,
        context.companyProfileId ?? "",
      )
      .first<{ id: string; value: string }>();
    pendingJobId = pending?.id;
    if (pending) await correlate(JSON.parse(pending.value));
  }
  if (!preferredConversationId) {
    const latest = await repo.db
      .prepare(
        "SELECT id FROM dossier_records WHERE owner_id=? AND kind='conversation' AND json_extract(value,'$.dossierId')=? AND COALESCE(json_extract(value,'$.companyProfileId'),'')=? ORDER BY updated_at DESC,id DESC LIMIT 1",
      )
      .bind(
        repo.context.ownerId,
        context.dossierId,
        context.companyProfileId ?? "",
      )
      .first<{ id: string }>();
    preferredConversationId = latest?.id;
  }
  let conversation: Awaited<ReturnType<typeof readConversation>> | null = null;
  if (preferredConversationId) {
    try {
      conversation = await readConversation(repo, preferredConversationId);
    } catch (error) {
      if (
        !(error instanceof DossierError) ||
        error.code !== "NOT_FOUND" ||
        !pendingJobId
      )
        throw error;
    }
  }
  const documents = new Map<string, string>();
  const messages: Array<Record<string, unknown>> = [];
  for (const turn of conversation?.turns ?? []) {
    const citations = [];
    const sourceCitations =
      turn.value.checklist?.sources.map((source) => ({
        ...source,
        excerpt: source.excerpt,
      })) ?? turn.value.citations;
    for (const [index, citation] of sourceCitations.entries()) {
      if (!documents.has(citation.documentVersionId)) {
        const doc = await repo.read<{ name?: string }>(
          "document",
          citation.documentVersionId,
        );
        documents.set(
          citation.documentVersionId,
          doc.value.name ?? "Fuente del expediente",
        );
      }
      citations.push({
        id: `S${String(index + 1).padStart(3, "0")}`,
        label: `${documents.get(citation.documentVersionId)}${citation.page ? ` · pág. ${citation.page}` : citation.section ? ` · ${citation.section}` : ""}`,
        excerpt: citation.excerpt,
      });
    }
    messages.push({
      id: `${turn.id}:user`,
      role: "user",
      text: turn.value.userMessage,
    });
    messages.push({
      id: turn.id,
      role: "assistant",
      text: turn.value.checklist
        ? renderExhaustiveChecklist(turn.value.checklist, {
            includeSourceExcerpts: false,
          })
        : turn.value.answer,
      citations,
      stale: turn.value.stale,
      insufficientEvidence:
        !turn.value.checklist && turn.value.insufficientEvidence,
    });
  }
  let coverage:
    | {
        total: number;
        indexed: number;
        pending: unknown[];
        reviewRequired: string[];
      }
    | undefined;
  let currentReport = false;
  if (dossier.value.reportId) {
    const report = (
      await repo.read<{
        dossierId: string;
        corpusRevision: number;
        coverage: typeof coverage;
      }>("report", String(dossier.value.reportId))
    ).value;
    currentReport =
      report.dossierId === context.dossierId &&
      report.corpusRevision === dossier.value.corpusRevision &&
      (dossier.value.coverage as { inventoryComplete?: boolean } | undefined)
        ?.inventoryComplete === true;
    if (currentReport) coverage = report.coverage;
  }
  const analysisComplete = currentReport && !dossier.value.needsSynthesis;
  const pending = coverage?.pending?.length ?? 0,
    review = coverage?.reviewRequired?.length ?? 0;
  const result = {
    conversationId: conversation?.id ?? preferredConversationId,
    revision: conversation?.revision ?? 0,
    messages,
    pendingJobId,
    coverage: {
      complete: analysisComplete && pending === 0 && review === 0,
      label: `${context.dossierId} · ${selectedCompany?.value.name ?? "Solo la licitación"} · ${analysisComplete ? "Análisis conjunto completado" : "Análisis conjunto pendiente"} · ${coverage?.indexed ?? 0}/${coverage?.total ?? 0} documentos · ${pending} pendientes · ${review} ${review === 1 ? "extracción" : "extracciones"} por revisar`,
    },
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 900_000)
    throw new DossierError("ASSISTANT_HISTORY_TOO_LARGE", 413);
  return result;
}
