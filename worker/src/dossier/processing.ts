import { extractCompanyFacts } from "./company-facts";
import { consumeOwnerLimit } from "./limits";
import { DossierError } from "./contracts";
import { DossierRepository, type Job } from "./repository";
import {
  refreshInventory,
  listProcessDocuments,
  getProcessDetail,
  type DocumentVersion,
} from "./inventory";
import {
  extractDocument,
  HttpExtractionProvider,
  CloudflareExtractionProvider,
  type ExtractionProvider,
  type MarkdownBinding,
} from "./extraction";
import { ConfiguredModel, type ModelProvider, type ModelEnv } from "./model";
import { synthesizeDossier } from "./synthesis";
import { assessCompany } from "./assessment";
import { answerTenderQuestion, type ChatInput } from "./conversations";
import type { PrivateServiceEnv } from "./api";
export type ProcessingEnv = PrivateServiceEnv &
  ModelEnv & {
    EXTRACTOR_URL?: string;
    EXTRACTOR_KEY?: string;
    AI?: ModelEnv["AI"] & Partial<MarkdownBinding>;
  };
export async function enqueueSynthesisWhenReady(
  repo: DossierRepository,
  dossierId: string,
) {
  const dossier = await repo.readDossier(dossierId);
  const ids = (dossier.value.documentIds ?? []) as string[];
  const docs = await Promise.all(
    ids.map((id) => repo.read<DocumentVersion>("document", id)),
  );
  if (docs.some((d) => d.value.state === "pending")) return;
  return repo.enqueueJob({
    kind: "synthesize",
    targetId: dossierId,
    key: `synthesis:${dossierId}:${dossier.value.corpusRevision}`,
  });
}
export async function executeProcessingJob(
  repo: DossierRepository,
  job: Job,
  env: ProcessingEnv,
  adapters?: { model?: ModelProvider; extractor?: ExtractionProvider },
) {
  const checkpoint = async (progress: Record<string, unknown> = {}) =>
    repo.checkpointJob(job.id, job.lease!, { ...job.progress, ...progress });
  const model = () =>
    adapters?.model ??
    new ConfiguredModel(
      env,
      () => checkpoint(),
      () =>
        consumeOwnerLimit(
          repo,
          "model-daily",
          Number(env.MODEL_DAILY_LIMIT ?? 1000),
          86400000,
        ),
    );
  switch (job.kind) {
    case "inventory": {
      await refreshInventory(repo, job.targetId, {
        page: (id, cursor) => listProcessDocuments(env, id, cursor),
        detail: (id) => getProcessDetail(env, id),
        checkpoint: () => checkpoint({ stage: "discovering" }),
      });
      await enqueueSynthesisWhenReady(repo, job.targetId);
      await checkpoint({
        dossierId: job.targetId,
        stage: "inventory_complete",
      });
      return;
    }
    case "extract": {
      const doc = await repo.read<DocumentVersion>("document", job.targetId);
      let extractor = adapters?.extractor;
      if (!extractor)
        extractor = env.EXTRACTOR_URL
          ? new HttpExtractionProvider(env)
          : env.AI?.toMarkdown
            ? new CloudflareExtractionProvider({
                toMarkdown: env.AI.toMarkdown.bind(env.AI),
              })
            : new HttpExtractionProvider(env);
      try {
        await extractDocument(repo, doc.id, extractor, () =>
          checkpoint({ stage: "extracting", documentId: doc.id }),
        );
      } catch (e) {
        if (
          !doc.value.dossierId.startsWith("company:") &&
          e instanceof DossierError &&
          !e.retryable
        )
          await enqueueSynthesisWhenReady(repo, doc.value.dossierId);
        throw e;
      }
      if (!doc.value.dossierId.startsWith("company:"))
        await enqueueSynthesisWhenReady(repo, doc.value.dossierId);
      else {
        const companyId = doc.value.dossierId.slice(8);
        const company = await repo.read("company", companyId);
        const docs = (await repo.all<DocumentVersion>("document")).filter(
          (d) => d.value.dossierId === doc.value.dossierId,
        );
        if (!docs.some((d) => d.value.state === "pending"))
          await repo.enqueueJob({
            kind: "company_facts",
            targetId: companyId,
            key: `company-facts:${companyId}:${company.revision}`,
          });
      }
      await checkpoint({ documentId: doc.id, stage: "extracted" });
      return;
    }
    case "synthesize": {
      const dossier = await repo.readDossier(job.targetId);
      const result = await synthesizeDossier(
        repo,
        job.targetId,
        Number(dossier.value.corpusRevision),
        model(),
      );
      await checkpoint({
        stage: "analyzed",
        dossierId: job.targetId,
        result: { reportId: `${job.targetId}:${result.corpusRevision}` },
      });
      return;
    }
    case "assess": {
      const request = await repo.read<{
        dossierId: string;
        companyId: string;
        selectedLots: string[];
        corpusRevision?: number;
        companyRevision?: number;
      }>("task", job.targetId);
      const dossier = await repo.readDossier(request.value.dossierId),
        company = await repo.read("company", request.value.companyId);
      if (
        (request.value.corpusRevision !== undefined &&
          request.value.corpusRevision !== dossier.value.corpusRevision) ||
        (request.value.companyRevision !== undefined &&
          request.value.companyRevision !== company.revision)
      )
        throw new DossierError("ASSESSMENT_INPUT_CHANGED", 409);
      const result = await assessCompany(
        repo,
        request.value.dossierId,
        request.value.companyId,
        request.value.selectedLots,
        model(),
      );
      await checkpoint({
        stage: "assessed",
        dossierId: request.value.dossierId,
        result: { assessmentId: result.id },
      });
      return;
    }
    case "company_facts": {
      await extractCompanyFacts(repo, job.targetId, model());
      await checkpoint({
        stage: "company_facts_ready",
        result: { companyId: job.targetId },
      });
      return;
    }
    case "chat": {
      const request = await repo.read<ChatInput>("message", job.targetId);
      const result = await answerTenderQuestion(repo, request.value, model());
      await checkpoint({
        stage: "answered",
        dossierId: request.value.dossierId,
        result: { conversationId: result.conversationId },
      });
      return;
    }
  }
}
