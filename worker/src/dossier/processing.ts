import { executeExpertStudy } from "./expert-study";
import { extractCompanyFacts } from "./company-facts";
import { consumeOwnerLimit } from "./limits";
import { DossierError, PRIVATE_SCOPES } from "./contracts";
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
  CpuOcrFallbackProvider,
  type OcrServiceBinding,
  CloudflareExtractionProvider,
  type ExtractionProvider,
  type MarkdownBinding,
} from "./extraction";
import { ConfiguredModel, type ModelProvider, type ModelEnv } from "./model";
import { synthesizeDossier } from "./synthesis";
import { assessCompany } from "./assessment";
import { answerTenderQuestion, type ChatInput } from "./conversations";
import type { PrivateServiceEnv } from "./api";
import type { RetrievalEnv } from "./retrieval";
export type ProcessingEnv = PrivateServiceEnv &
  ModelEnv &
  RetrievalEnv & {
    AGENT_MODEL_NAME?: string;
    SECOP_OCR?: OcrServiceBinding;
    EXTRACTOR_URL?: string;
    EXTRACTOR_KEY?: string;
    AI?: ModelEnv["AI"] & Partial<MarkdownBinding>;
  };
export async function enqueueSynthesisWhenReady(
  repo: DossierRepository,
  dossierId: string,
  finishingJobId?: string,
  resumeTerminalSynthesis = false,
) {
  const dossier = await repo.readDossier(dossierId);
  const ids = (dossier.value.documentIds ?? []) as string[];
  const docs = await Promise.all(
    ids.map((id) => repo.read<DocumentVersion>("document", id)),
  );
  if (docs.some((d) => d.value.state === "pending")) return;
  const active = await repo.db
    .prepare(
      "SELECT 1 AS found FROM dossier_jobs WHERE owner_id=? AND kind='extract' AND state IN ('queued','running') AND id!=? AND target_id IN (SELECT value FROM json_each(?)) LIMIT 1",
    )
    .bind(repo.context.ownerId, finishingJobId ?? "", JSON.stringify(ids))
    .first();
  if (active) return;
  return repo.enqueueJob({
    kind: "synthesize",
    targetId: dossierId,
    key: `synthesis:${dossierId}:${dossier.value.corpusRevision}`,
    resumeTerminalSynthesis,
  });
}
async function enqueueAfterExtraction(
  repo: DossierRepository,
  document: DocumentVersion,
  finishingJobId?: string,
) {
  if (!document.dossierId.startsWith("company:"))
    await enqueueSynthesisWhenReady(repo, document.dossierId, finishingJobId);
  else {
    const companyId = document.dossierId.slice(8);
    const company = await repo.read("company", companyId);
    const docs = (await repo.all<DocumentVersion>("document")).filter(
      (d) => d.value.dossierId === document.dossierId,
    );
    if (!docs.some((d) => d.value.state === "pending"))
      await repo.enqueueJob({
        kind: "company_facts",
        targetId: companyId,
        key: `company-facts:${companyId}:${company.revision}`,
      });
  }
}
export async function recoverTerminalExtractions(env: ProcessingEnv) {
  if (!env.DOSSIER_DB || !env.DOSSIER_FILES) return;
  const rows = await env.DOSSIER_DB.prepare(
    "SELECT DISTINCT r.owner_id AS ownerId,r.id AS documentId FROM dossier_records r JOIN dossier_jobs j ON j.owner_id=r.owner_id AND j.target_id=r.id AND j.kind='extract' WHERE r.kind='document' AND json_extract(r.value,'$.state')='pending' AND j.state='failed' AND NOT EXISTS(SELECT 1 FROM dossier_jobs active WHERE active.owner_id=r.owner_id AND active.target_id=r.id AND active.kind='extract' AND active.state IN ('queued','running')) LIMIT 50",
  ).all<{ ownerId: string; documentId: string }>();
  for (const row of rows.results) {
    const repo = new DossierRepository(env, {
      ownerId: row.ownerId,
      scopes: [...PRIVATE_SCOPES],
    });
    const doc = await repo.read<DocumentVersion>("document", row.documentId);
    if (doc.value.state !== "pending") continue;
    await repo.save(
      "document",
      doc.id,
      { ...doc.value, state: "failed", error: "EXTRACTION_RETRIES_EXHAUSTED" },
      doc.revision,
    );
    await enqueueAfterExtraction(repo, doc.value);
  }
}
export async function executeProcessingJob(
  repo: DossierRepository,
  job: Job,
  env: ProcessingEnv,
  adapters?: { model?: ModelProvider; extractor?: ExtractionProvider },
) {
  let latestProgress = { ...job.progress };
  const checkpoint = async (progress: Record<string, unknown> = {}) => {
    latestProgress = { ...latestProgress, ...progress };
    await repo.checkpointJob(job.id, job.lease!, latestProgress);
  };
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
      await enqueueSynthesisWhenReady(repo, job.targetId, undefined, true);
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
      if (!adapters?.extractor && env.SECOP_OCR && !env.EXTRACTOR_URL)
        extractor = new CpuOcrFallbackProvider(extractor, env.SECOP_OCR, {
          load: async () => {
            const saved = await repo.getFile(`ocr-pages-v1.${doc.id}`);
            return saved ? JSON.parse(await saved.text()) : null;
          },
          save: async (value) => {
            await repo.putFile(
              `ocr-pages-v1.${doc.id}`,
              new TextEncoder().encode(JSON.stringify(value)),
              "application/json",
            );
            const batch = value as { pages: unknown[]; pageCount: number };
            await checkpoint({
              extractedPages: batch.pages.length,
              pageCount: batch.pageCount,
              stage: "ocr_pages",
            });
          },
        });
      try {
        await extractDocument(repo, doc.id, extractor, () =>
          checkpoint({ stage: "extracting", documentId: doc.id }),
        );
      } catch (e) {
        if (e instanceof DossierError && (!e.retryable || job.attempts >= 5)) {
          const current = await repo.read<DocumentVersion>("document", doc.id);
          if (current.value.state === "pending")
            await repo.save(
              "document",
              doc.id,
              { ...current.value, state: "failed", error: e.code },
              current.revision,
            );
          await enqueueAfterExtraction(repo, doc.value, job.id);
        }
        throw e;
      }
      await enqueueAfterExtraction(repo, doc.value, job.id);
      await checkpoint({ documentId: doc.id, stage: "extracted" });
      return;
    }
    case "synthesize": {
      const dossier = await repo.readDossier(job.targetId);
      const provider = model();
      await checkpoint({ stage: "analyzing_documents", model: provider.id });
      const result = await synthesizeDossier(
        repo,
        job.targetId,
        Number(dossier.value.corpusRevision),
        provider,
        checkpoint,
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
      await executeExpertStudy(repo, job, env, adapters);
      return;
    }
  }
}
