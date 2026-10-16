import { sha256 } from "./downloads";
import { renderExhaustiveChecklist } from "./checklist";
import { z } from "zod/v4";
import { DossierError } from "./contracts";
import { DossierRepository } from "./repository";
import { readConversation, type Conversation } from "./conversations";
import { createSourceTicket, hasStoredPdf } from "./sources";
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
          method: z.literal("open-source"),
          messageId: id,
          citationId: z.string().regex(/^S\d{3,}$/),
        })
        .strict(),
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
  origin = "",
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
  let selectedSource:
    | { documentId: string; dossierId: string; page?: number }
    | undefined;
  const documents = new Map<
    string,
    { name: string; canOpen: boolean }
  >();
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
  if (request.method === "open-source") {
    const conversationMatches = await repo.db
      .prepare(
        "SELECT c.id,c.value FROM dossier_records c JOIN json_each(c.value,'$.turnIds') t WHERE c.owner_id=? AND c.kind='conversation' AND json_extract(c.value,'$.dossierId')=? AND COALESCE(json_extract(c.value,'$.companyProfileId'),'')=? AND t.value=? LIMIT 2",
      )
      .bind(
        repo.context.ownerId,
        context.dossierId,
        context.companyProfileId ?? "",
        request.messageId,
      )
      .all<{ id: string; value: string }>();
    const found = conversationMatches.results[0];
    if (!found || conversationMatches.results.length !== 1)
      throw new DossierError("SOURCE_CITATION_NOT_FOUND", 404);
    const conversationValue = JSON.parse(found.value) as Conversation;
    if (!matches(conversationValue))
      throw new DossierError("CONVERSATION_CONTEXT_MISMATCH", 403);
    preferredConversationId = found.id;
    const turn = await repo.read<Record<string, any>>("message", request.messageId);
    const sources = turn.value.checklist?.sources ?? turn.value.citations ?? [];
    const index = Number(request.citationId.slice(1)) - 1;
    const citation = sources[index];
    if (!citation || request.citationId !== `S${String(index + 1).padStart(3, "0")}`)
      throw new DossierError("SOURCE_CITATION_NOT_FOUND", 404);
    const document = await repo.read<Record<string, any>>(
      "document",
      citation.documentVersionId,
    );
    if (
      document.value.dossierId !== context.dossierId ||
      (turn.value.checklist && turn.value.checklist.dossierId !== context.dossierId)
    )
      throw new DossierError("SOURCE_CITATION_NOT_FOUND", 404);
    const canOpen = await hasStoredPdf(repo, document.value, context.dossierId);
    if (!canOpen)
      throw new DossierError("SOURCE_NOT_AVAILABLE", 404);
    documents.set(citation.documentVersionId, {
      name: typeof document.value.name === "string"
        ? document.value.name
        : "Fuente del expediente",
      canOpen,
    });
    selectedSource = {
      documentId: citation.documentVersionId,
      dossierId: context.dossierId,
      ...(Number.isSafeInteger(citation.page) && citation.page > 0
        ? { page: citation.page }
        : {}),
    };
  } else if (request.method === "send") {
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
      conversation = await readConversation(repo, preferredConversationId, 0);
      if (conversation.value.turnIds.length > 1000)
        throw new DossierError("ASSISTANT_HISTORY_TOO_LARGE", 413);
      let cursor = conversation.nextCursor;
      while (cursor !== null) {
        const page = await readConversation(
          repo,
          preferredConversationId,
          cursor,
        );
        if (page.revision !== conversation.revision)
          throw new DossierError("REVISION_CONFLICT", 409, true);
        conversation.turns.push(...page.turns);
        cursor = page.nextCursor;
      }
    } catch (error) {
      if (
        !(error instanceof DossierError) ||
        error.code !== "NOT_FOUND" ||
        !pendingJobId
      )
        throw error;
    }
  }
  const messages: Array<Record<string, unknown>> = [];
  const latestChecklistTurnId = [...(conversation?.turns ?? [])]
    .reverse()
    .find((turn) => turn.value.checklist)?.id;
  for (const turn of conversation?.turns ?? []) {
    const citations = [];
    const sourceCitations =
      turn.value.checklist?.sources.map((source) => ({
        ...source,
        excerpt: source.excerpt,
      })) ?? turn.value.citations;
    for (const [index, citation] of sourceCitations.entries()) {
      let document = documents.get(citation.documentVersionId);
      if (!document) {
        const doc = await repo.read<Record<string, unknown>>(
          "document",
          citation.documentVersionId,
        );
        document = {
          name:
            typeof doc.value.name === "string"
              ? doc.value.name
              : "Fuente del expediente",
          canOpen: await hasStoredPdf(repo, doc.value, context.dossierId),
        };
        documents.set(
          citation.documentVersionId,
          document,
        );
      }
      citations.push({
        id: `S${String(index + 1).padStart(3, "0")}`,
        label: `${document.name}${citation.page ? ` · pág. ${citation.page}` : citation.section ? ` · ${citation.section}` : ""}`,
        excerpt: citation.excerpt,
        ...(document.canOpen ? { canOpen: true } : {}),
      });
    }
    if (
      turn.value.checklist &&
      turn.id === latestChecklistTurnId &&
      turn.value.checklist.items.length > 1000
    )
      throw new DossierError("TASK_SUGGESTIONS_TOO_LARGE", 413);
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
      ...(turn.value.checklist && turn.id === latestChecklistTurnId
        ? {
            taskSuggestions: turn.value.checklist.items
              .map((item) => {
                const suffix = `\nReferencia: ${item.reference}. Categoría: ${item.category}.`;
                if (item.wording.length + suffix.length > 20_000)
                  throw new DossierError("TASK_SUGGESTION_TOO_LARGE", 413);
                return {
                  id: item.requirementId || item.reference,
                  title: item.wording.slice(0, 200),
                  description: `${item.wording}${suffix}`,
                  citationIds: item.citations
                    .map((citation) => {
                      const sourceIndex = turn.value.checklist!.sources.findIndex(
                        (source) => source.reference === citation.sourceRef,
                      );
                      return sourceIndex < 0
                        ? null
                        : `S${String(sourceIndex + 1).padStart(3, "0")}`;
                    })
                    .filter((citationId): citationId is string => citationId !== null),
                };
              }),
          }
        : {}),
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
  if (review > 0) {
    const warning = `${review} ${review === 1 ? "extracción requiere" : "extracciones requieren"} revisión contra el original. El texto extraído no confirma su exactitud ni el cumplimiento.`;
    // Keep current extraction limitations in each displayed/exported answer, not
    // only in the panel header, so copying cannot drop this qualification.
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      message.text = `${message.text}\n\n${warning}`;
      message.insufficientEvidence = true;
    }
  }
  const result = {
    conversationId: conversation?.id ?? preferredConversationId,
    revision: conversation?.revision ?? 0,
    messages,
    pendingJobId,
    coverage: {
      complete: analysisComplete && pending === 0 && review === 0,
      label: `${context.dossierId} · ${selectedCompany?.value.name ?? "Solo la licitación"} · ${analysisComplete ? "Análisis conjunto completado" : "Análisis conjunto pendiente"} · ${coverage?.indexed ?? 0}/${coverage?.total ?? 0} documentos · ${pending} pendientes · ${review} ${review === 1 ? "extracción" : "extracciones"} por revisar`,
    },
    ...(selectedSource
      ? {
          source: await (async () => {
            const ticket = await createSourceTicket(repo, selectedSource!);
            const pageHash = ticket.page ? `#page=${ticket.page}` : "";
            return {
              url: `${origin}/private/source/${encodeURIComponent(ticket.token)}${pageHash}`,
              ...(ticket.page ? { page: ticket.page } : {}),
            };
          })(),
        }
      : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 900_000)
    throw new DossierError("ASSISTANT_HISTORY_TOO_LARGE", 413);
  return result;
}
