import {
  executeProcessingJob,
  recoverTerminalExtractions,
  enqueueSynthesisWhenReady,
} from "../src/dossier/processing";
import { DossierError } from "../src/dossier/contracts";
import { executePrivateOperation } from "../src/dossier/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { extractCompanyFacts } from "../src/dossier/company-facts";
import { reviewCompanyFact } from "../src/dossier/companies";
import { consumeOwnerLimit } from "../src/dossier/limits";
import { DossierRepository } from "../src/dossier/repository";
import { refreshInventory } from "../src/dossier/inventory";
import { saveExtraction } from "../src/dossier/extraction";
import { synthesizeDossier } from "../src/dossier/synthesis";
import { saveCompanyProfile } from "../src/dossier/companies";
import {
  assessCompany,
  readAssessment,
  reviewFinding,
} from "../src/dossier/assessment";
import {
  answerTenderQuestion,
  readConversation,
} from "../src/dossier/conversations";
import type { ModelProvider } from "../src/dossier/model";
import { renderExhaustiveChecklist } from "../src/dossier/checklist";
let mf: Miniflare, repo: DossierRepository;
let now = Date.parse("2026-10-15T12:00:00Z");
const model: ModelProvider = {
  id: "fixture-model",
  async generate(input) {
    const c = input.evidence.find(c => c.text.length >= 3)!;
    switch (input.purpose) {
      case "extract_requirements":
        return {
          summary: c.text,
          requirements: [
            {
              wording: c.text,
              category: "experience",
              mandatory: true,
              lot: null,
              deadline: null,
              rule: null,
              citations: [
                {
                  documentVersionId: c.documentVersionId,
                  page: c.page,
                  section: c.section,
                  excerpt: c.text.slice(0, 100),
                },
              ],
            },
          ],
          conflicts: [],
        };
      case "joint_requirement_review":
        return {
          summary: "Prepare the requested software and experience evidence.",
          candidates: [],
        };
      case "cross_document_review":
        return {
          summary: "Prepare the requested software and experience evidence.",
          conflicts: [],
          amendments: [],
        };
      case "company_fit":
        return {
          status: "meets",
          reason: "Current company certificates support the condition.",
          missing: [],
          companyCitations: [
            {
              documentVersionId: c.documentVersionId,
              page: c.page,
              excerpt: c.text,
            },
          ],
        };
      case "tender_conversation":
        if (!c)
          return {
            answer: "No matching evidence was retrieved.",
            insufficientEvidence: true,
            citations: [],
          };
        return {
          answer: "The tender requires experience certificates.",
          insufficientEvidence: false,
          citations: [
            {
              sourceRef: `E${input.evidence.indexOf(c) + 1}`,
              excerpt: c.text.slice(0, 100),
            },
          ],
        };
      default:
        throw new Error(input.purpose);
    }
  },
};
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
  const db = await mf.getD1Database("DOSSIER_DB");
  await db.exec(
    readFileSync(
      new URL("../migrations/0001_dossiers.sql", import.meta.url),
      "utf8",
    ),
  );
  repo = new DossierRepository(
    {
      DOSSIER_DB: db as unknown as D1Database,
      DOSSIER_FILES: (await mf.getR2Bucket(
        "DOSSIER_FILES",
      )) as unknown as R2Bucket,
    },
    {
      ownerId: "test-owner",
      scopes: [
        "dossier:read",
        "dossier:write",
        "company:write",
        "conversation:write",
      ],
    },
    () => now,
  );
});
afterAll(async () => mf?.dispose());
describe("persisted dossier, assessment and chat workflow", () => {
  it("publishes a partial dossier after extraction exhausts its retries", async () => {
    const dossier = await repo.createOrGetDossier("CO1.REQ.77");
    await repo.save(
      "dossier",
      dossier.id,
      {
        ...dossier.value,
        corpusRevision: 1,
        documentIds: ["terminal-document"],
      },
      dossier.revision,
    );
    await repo.save(
      "document",
      "terminal-document",
      {
        dossierId: dossier.id,
        processId: dossier.id,
        sourceId: "terminal",
        name: "terminal.pdf",
        url: null,
        fileId: "terminal-document",
        corpusRevision: 1,
        state: "pending",
      },
      0,
    );
    await repo.putFile(
      "terminal-document",
      new TextEncoder().encode("%PDF-1.7 terminal fixture"),
      "application/pdf",
    );
    const queued = await repo.enqueueJob({
      kind: "extract",
      targetId: "terminal-document",
      key: "terminal-extraction",
    });
    const claimed = await repo.claimJob(queued.id);
    await expect(
      executeProcessingJob(repo, { ...claimed!, attempts: 5 }, repo.env, {
        extractor: {
          extract: async () => {
            throw new DossierError("EXTRACTION_FAILED", 502, true);
          },
        },
      }),
    ).rejects.toThrow("EXTRACTION_FAILED");
    expect(
      (await repo.read<any>("document", "terminal-document")).value.state,
    ).toBe("failed");
    expect(
      (await repo.listDispatchableJobs()).some(
        (j) => j.kind === "synthesize" && j.targetId === dossier.id,
      ),
    ).toBe(true);
    const current = await repo.readDossier(dossier.id);
    await repo.save(
      "dossier",
      dossier.id,
      {
        ...current.value,
        documentIds: ["terminal-document", "abandoned-document"],
      },
      current.revision,
    );
    await repo.save(
      "document",
      "abandoned-document",
      {
        dossierId: dossier.id,
        processId: dossier.id,
        sourceId: "abandoned",
        name: "abandoned.pdf",
        url: null,
        corpusRevision: 1,
        state: "pending",
      },
      0,
    );
    const abandoned = await repo.enqueueJob({
      kind: "extract",
      targetId: "abandoned-document",
      key: "abandoned-extraction",
    });
    const lease = await repo.claimJob(abandoned.id);
    await repo.failJob(abandoned.id, lease!.lease!, "RETRY_LIMIT", false);
    await recoverTerminalExtractions(repo.env);
    expect(
      (await repo.read<any>("document", "abandoned-document")).value.state,
    ).toBe("failed");
  });
  it("rejects an assessment idempotency key reused for changed input revisions", async () => {
    const dossier = await repo.createOrGetDossier("CO1.REQ.88");
    const company = await saveCompanyProfile(
      repo,
      { name: "Idempotency fixture", facts: [] },
      0,
    );
    const input = {
      dossierId: dossier.id,
      companyId: company.id,
      corpusRevision: 0,
      companyRevision: company.revision,
      selectedLots: [],
      idempotencyKey: "assessment-revision-key",
    };
    await executePrivateOperation(
      repo.env,
      repo.context,
      "assess",
      input,
      "https://secop.test",
    );
    const next = await repo.save(
      "company",
      company.id,
      { ...company.value, activities: "Changed" },
      company.revision,
    );
    await expect(
      executePrivateOperation(
        repo.env,
        repo.context,
        "assess",
        { ...input, companyRevision: next.revision },
        "https://secop.test",
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });

  it("invalidates the old report and clears the OCR error after recovering an unreadable document", async () => {
    const dossierId = "CO1.REQ.OCR-RECOVERY";
    await repo.save(
      "dossier",
      dossierId,
      {
        processId: dossierId,
        corpusRevision: 1,
        needsSynthesis: false,
        reportRevision: 1,
        documentIds: ["ocr-recovery"],
      },
      0,
    );
    await repo.save(
      "document",
      "ocr-recovery",
      {
        name: "Scan.pdf",
        dossierId,
        state: "failed",
        error: "OCR_REQUIRED",
        corpusRevision: 1,
      },
      0,
    );
    await saveExtraction(repo, "ocr-recovery", {
      parserVersion: "cpu-ocr",
      pages: [{ page: 1, text: "The actual submission deadline is tomorrow." }],
      warnings: ["OCR_TEXT_REQUIRES_REVIEW"],
      complete: true,
    });
    const document = await repo.read<any>("document", "ocr-recovery");
    expect(document.value.error).toBeUndefined();
    expect(document.value.state).toBe("review_required");
    const dossier = await repo.readDossier(dossierId);
    expect(dossier.value.corpusRevision).toBe(2);
    expect(dossier.value.needsSynthesis).toBe(true);
  });

  it("waits for queued recovery jobs even when their document still has a failed state", async () => {
    const id = "CO1.REQ.OCR-QUEUE";
    await repo.save(
      "dossier",
      id,
      { processId: id, corpusRevision: 1, documentIds: ["ocr-wait"] },
      0,
    );
    await repo.save(
      "document",
      "ocr-wait",
      {
        name: "Scan.pdf",
        dossierId: id,
        state: "failed",
        error: "OCR_REQUIRED",
      },
      0,
    );
    const job = await repo.enqueueJob({
      kind: "extract",
      targetId: "ocr-wait",
      key: "ocr-wait-extraction",
    });
    expect(await enqueueSynthesisWhenReady(repo, id)).toBeUndefined();
    expect(await enqueueSynthesisWhenReady(repo, id, job.id)).toMatchObject({
      kind: "synthesize",
    });
  });

  it("extracts cited company figures as reviewable candidates instead of automatically verified facts", async () => {
    const company = await saveCompanyProfile(
      repo,
      { name: "Synthetic financial fixture", facts: [] },
      0,
    );
    const documentId = "financial-fixture";
    await repo.save(
      "document",
      documentId,
      {
        name: "Financials.pdf",
        dossierId: `company:${company.id}`,
        state: "pending",
        corpusRevision: 1,
      },
      0,
    );
    await repo.save(
      "evidence",
      documentId,
      { companyId: company.id, documentId },
      0,
    );
    await saveExtraction(repo, documentId, {
      parserVersion: "fixture",
      pages: [{ page: 1, text: "Liquidity ratio 1.5 for fiscal year 2025." }],
      warnings: [],
      complete: true,
    });
    const candidate = await extractCompanyFacts(repo, company.id, {
      id: "fixture",
      generate: async () => ({
        facts: [
          {
            field: "liquidity",
            value: 1.5,
            unit: "ratio",
            period: "2025",
            citations: [
              {
                documentVersionId: documentId,
                page: 1,
                excerpt: "Liquidity ratio 1.5 for fiscal year 2025.",
              },
            ],
          },
        ],
      }),
    });
    expect(candidate.value.facts[0].reviewed).toBe(false);
    const reviewed = await reviewCompanyFact(
      repo,
      company.id,
      0,
      "Checked against the cited original.",
      candidate.revision,
    );
    expect(reviewed.value.facts[0].reviewed).toBe(true);
  });

  it("enforces an atomic owner budget without affecting a different owner", async () => {
    await consumeOwnerLimit(repo, "test", 2, 60000);
    await consumeOwnerLimit(repo, "test", 2, 60000);
    await expect(consumeOwnerLimit(repo, "test", 2, 60000)).rejects.toThrow(
      "OWNER_RATE_LIMIT",
    );
    const other = new DossierRepository(
      repo.env,
      { ...repo.context, ownerId: "other" },
      () => now,
    );
    await consumeOwnerLimit(other, "test", 2, 60000);
  });
  it("retains complete inventory, multiple cited sources, company gaps and conversation after repository reload", async () => {
    const d = await repo.createOrGetDossier("CO1.REQ.99");
    const inventory = await refreshInventory(repo, d.id, {
      detail: async () => ({
        description: "Deliver software and provide experience certificates",
      }),
      page: async () => ({
        items: ["1", "2"].map((sourceId) => ({
          sourceId,
          processId: d.id,
          name: `${sourceId}.pdf`,
          url: `https://community.secop.gov.co/Public/Archive/RetrieveFile/Index?DocumentId=${sourceId}`,
        })),
        nextCursor: null,
      }),
    });
    const docs = inventory.value.documentIds as string[];
    await saveExtraction(repo, docs[0], {
      parserVersion: "test",
      pages: [{ page: 1, text: "Provide three experience certificates." }],
      warnings: [],
      complete: true,
    });
    await saveExtraction(repo, docs[1], {
      parserVersion: "test",
      pages: [{ page: 2, text: "Deliver the software within 30 days." }],
      warnings: [],
      complete: true,
    });
    const report = await synthesizeDossier(repo, d.id, 1, model);
    expect(report.coverage.indexed).toBe(2);
    expect(report.requirementIds.length).toBeGreaterThanOrEqual(3);
    const company = await saveCompanyProfile(
      repo,
      { name: "Company", facts: [] },
      0,
    );
    const empty = await assessCompany(repo, d.id, company.id, [], {
      ...model,
      async generate(input) {
        if (input.purpose === "company_fit")
          return {
            status: "meets",
            reason: "Unfounded positive",
            missing: [],
            companyCitations: [],
          };
        return model.generate(input);
      },
    });
    expect(empty.readiness).toBe("missing_requirements");
    await repo.save(
      "document",
      "company-doc",
      {
        name: "Experience.pdf",
        dossierId: `company:${company.id}`,
        state: "pending",
        corpusRevision: company.revision,
        expiresOn: "2026-12-31",
      },
      0,
    );
    await repo.save(
      "evidence",
      "company-doc",
      { companyId: company.id, documentId: "company-doc" },
      0,
    );
    await saveExtraction(repo, "company-doc", {
      parserVersion: "test",
      pages: [
        {
          page: 1,
          text: "Company completed three software contracts and can deliver in 30 days.",
        },
      ],
      warnings: [],
      complete: true,
    });
    const updated = await repo.save(
      "company",
      company.id,
      { ...company.value, evidenceChangedAt: now },
      company.revision,
    );
    const assessment = await assessCompany(repo, d.id, company.id, [], model);
    expect(assessment.companyRevision).toBe(updated.revision);
    expect(assessment.readiness).toBe("ready_for_user_review");
    const question = {
      dossierId: d.id,
      companyProfileId: company.id,
      expectedRevision: 0,
      message: "What experience is required?",
      idempotencyKey: "question-0001",
    };
    const turn = await answerTenderQuestion(repo, question, model);
    const same = await answerTenderQuestion(repo, question, model);
    expect(same.duplicate).toBe(true);
    const reloaded = new DossierRepository(repo.env, repo.context, () => now);
    expect(
      (await readConversation(reloaded, turn.conversationId)).turns,
    ).toHaveLength(1);
    const saved = await repo.read<any>("assessment", assessment.id);
    await reviewFinding(
      repo,
      assessment.id,
      assessment.findings[0].requirementId,
      "insufficient_evidence",
      "Certificate needs a user check",
      saved.revision,
    );
    expect((await readAssessment(repo, assessment.id)).reviews).toHaveLength(1);
    const effective = await readAssessment(repo, assessment.id);
    expect(
      effective.value.findings.find(
        (f) => f.requirementId === assessment.findings[0].requirementId,
      )?.status,
    ).toBe("insufficient_evidence");
    expect(effective.readiness).toBe("missing_requirements");
    now = Date.parse("2027-01-01T12:00:00Z");
    expect((await readAssessment(repo, assessment.id)).stale).toBe(true);
  });
  it("marks answers stale when the corpus refreshes during generation", async () => {
    const conv = (
      await repo.list<{ companyProfileId: string }>("conversation")
    )[0];
    const company = await repo.read("company", conv.value.companyProfileId);
    const turn = await answerTenderQuestion(
      repo,
      {
        dossierId: "CO1.REQ.99",
        companyProfileId: company.id,
        conversationId: conv.id,
        expectedRevision: conv.revision,
        message: "What are the obligations?",
        idempotencyKey: "question-0002",
      },
      {
        ...model,
        async generate(input) {
          const d = await repo.readDossier("CO1.REQ.99");
          await repo.save(
            "dossier",
            d.id,
            { ...d.value, corpusRevision: 2 },
            d.revision,
          );
          return model.generate(input);
        },
      },
    );
    expect(turn.stale).toBe(true);
    expect(turn.corpusRevision).toBe(1);
  });
  it("retries a failed conversation reservation only for the same unchanged request", async () => {
    const first = await answerTenderQuestion(
      repo,
      {
        dossierId: "CO1.REQ.99",
        expectedRevision: 0,
        message: "What experience is required?",
        idempotencyKey: "conversation-retry-seed",
      },
      model,
    );
    const retryInput = {
      dossierId: "CO1.REQ.99",
      conversationId: first.conversationId,
      expectedRevision: first.revision,
      message: "Which delivery timeline applies?",
      idempotencyKey: "conversation-retry-key",
    };
    const retryableModel: ModelProvider = {
      ...model,
      async generate(input) {
        if (input.purpose === "tender_conversation")
          throw new DossierError("MODEL_TEMPORARILY_UNAVAILABLE", 503, true);
        return model.generate(input);
      },
    };

    await expect(
      answerTenderQuestion(repo, retryInput, retryableModel),
    ).rejects.toMatchObject({ code: "MODEL_TEMPORARILY_UNAVAILABLE" });
    const failed = await readConversation(repo, first.conversationId);
    expect(failed.turns).toHaveLength(1);

    await expect(
      answerTenderQuestion(
        repo,
        { ...retryInput, idempotencyKey: "different-stale-key" },
        model,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const retried = await answerTenderQuestion(repo, retryInput, model);
    expect(retried.duplicate).toBe(false);
    expect(
      (await readConversation(repo, first.conversationId)).turns,
    ).toHaveLength(2);
    expect(
      (await answerTenderQuestion(repo, retryInput, model)).duplicate,
    ).toBe(true);
    expect(
      (await readConversation(repo, first.conversationId)).turns,
    ).toHaveLength(2);

    const intervenedRetry = {
      ...retryInput,
      expectedRevision: retried.revision,
      message: "Which documents must be submitted?",
      idempotencyKey: "conversation-retry-after-intervening-turn",
    };
    await expect(
      answerTenderQuestion(repo, intervenedRetry, retryableModel),
    ).rejects.toMatchObject({ code: "MODEL_TEMPORARILY_UNAVAILABLE" });
    const afterSecondFailure = await readConversation(
      repo,
      first.conversationId,
    );
    const intervening = await answerTenderQuestion(
      repo,
      {
        ...retryInput,
        expectedRevision: afterSecondFailure.revision,
        message: "When is the deadline?",
        idempotencyKey: "conversation-intervening-turn",
      },
      model,
    );
    expect(intervening.duplicate).toBe(false);
    await expect(
      answerTenderQuestion(repo, intervenedRetry, model),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      (await readConversation(repo, first.conversationId)).turns,
    ).toHaveLength(3);
  });
  it("passes the full current corpus to chat and excludes foreign tender and owner sources", async () => {
    const id = "CO1.REQ.990001";
    const dossier = await repo.createOrGetDossier(id);
    await repo.save(
      "dossier",
      id,
      {
        ...dossier.value,
        documentIds: ["rag-current"],
        reportId: "rag-report",
        needsSynthesis: false,
        state: "analyzed",
      },
      dossier.revision,
    );
    await repo.save(
      "report",
      "rag-report",
      {
        summary: "Obsolete report with incorrect requirements",
        corpusRevision: -1,
      },
      0,
    );
    await repo.save(
      "chunk",
      "rag-local",
      {
        documentVersionId: "rag-current",
        page: 1,
        index: 0,
        text: "El personal debe presentar títulos universitarios en ingeniería.",
      },
      0,
    );
    await repo.save(
      "chunk",
      "rag-foreign",
      {
        documentVersionId: "rag-other-tender",
        page: 1,
        index: 0,
        text: "Acreditaciones profesionales: licencia de aviación para Tender B.",
      },
      0,
    );
    const foreign = new DossierRepository(repo.env, {
      ...repo.context,
      ownerId: "other-owner",
    });
    await foreign.save(
      "chunk",
      "rag-private",
      {
        documentVersionId: "rag-current",
        page: 1,
        index: 0,
        text: "Confidential requirements belonging to another owner.",
      },
      0,
    );
    let vectors: any[] = [];
    let context: any;
    const result = await answerTenderQuestion(
      repo,
      {
        dossierId: id,
        expectedRevision: 0,
        message: "¿Qué acreditaciones profesionales necesitamos?",
        idempotencyKey: "rag-isolation-question",
      },
      {
        id: "fixture",
        async generate(input) {
          context = input;
          const source = input.evidence.find(
            (c) => c.documentVersionId === "rag-current",
          )!;
          return {
            answer: "Se exigen títulos universitarios en ingeniería.",
            insufficientEvidence: false,
            citations: [
              {
                sourceRef: `E${input.evidence.indexOf(source) + 1}`,
                excerpt: source.text,
              },
            ],
          };
        },
      },
      {
        env: {
          AI: {
            async run(_model: string, input: any) {
              return { data: input.text.map(() => Array(1024).fill(0.01)) };
            },
          },
          DOSSIER_VECTORS: {
            async upsert(rows: any[]) {
              vectors.push(...rows);
              return { mutationId: "fixture" };
            },
            async query(_values: any, options: any) {
              expect(options.namespace).toBeTruthy();
              expect(options.filter).toMatchObject({
                ownerScope: expect.anything(),
                tenderScope: expect.anything(),
                generation: expect.anything(),
              });
              return {
                matches: [
                  {
                    ...vectors[0],
                    score: 0.99,
                    metadata: {
                      ...vectors[0].metadata,
                      tenderScope: "foreign",
                    },
                  },
                  { ...vectors[0], id: "foreign-source", score: 0.98 },
                  ...vectors.map((vector) => ({ ...vector, score: 0.95 })),
                ],
              };
            },
          },
        },
      },
    );
    expect(JSON.stringify(context.context.reportOverview)).not.toContain(
      "Obsolete report",
    );
    expect(context.context.retrieval.mode).toBe("full_corpus");
    expect(context.evidence.map((c: any) => c.text).join(" ")).toContain(
      "títulos universitarios",
    );
    expect(context.evidence.map((c: any) => c.text).join(" ")).not.toMatch(
      /aviación|Confidential/,
    );
    expect(result.retrieval.mode).toBe("full_corpus");
    const stored = await readConversation(repo, result.conversationId);
    expect((stored.turns[0].value as any).retrieval.mode).toBe("full_corpus");
    expect(result.citations[0].documentVersionId).toBe("rag-current");
  });
  it("separates pending analysis from source freshness for new and historical answers", async () => {
    const d = await repo.createOrGetDossier("CO1.REQ.990002");
    await repo.save(
      "dossier",
      d.id,
      {
        ...d.value,
        corpusRevision: 6,
        state: "partial",
        needsSynthesis: true,
        reportId: "freshness-report",
      },
      d.revision,
    );
    await repo.save(
      "report",
      "freshness-report",
      { corpusRevision: 1, summary: "Old report" },
      0,
    );
    const answer = await answerTenderQuestion(
      repo,
      {
        dossierId: d.id,
        expectedRevision: 0,
        message: "What experience is required?",
        idempotencyKey: "source-freshness-pending",
      },
      model,
    );
    expect(answer.stale).toBe(false);
    expect(answer.analysisPending).toBe(true);

    const raw = await repo.read<any>("message", answer.turnId);
    await repo.save(
      "message",
      raw.id,
      { ...raw.value, stale: true },
      raw.revision,
    );
    const current = await readConversation(repo, answer.conversationId);
    expect(current.turns[0].value.stale).toBe(false);
    expect(current.turns[0].value.analysisPending).toBe(true);
    expect((await repo.read<any>("message", raw.id)).value.stale).toBe(true);

    const latest = await repo.readDossier(d.id);
    await repo.save(
      "dossier",
      d.id,
      {
        ...latest.value,
        corpusRevision: 7,
        needsSynthesis: false,
        state: "analyzed",
      },
      latest.revision,
    );
    const changed = await readConversation(repo, answer.conversationId);
    expect(changed.turns[0].value.stale).toBe(true);
    expect(changed.turns[0].value.analysisPending).toBe(false);
  });
  it("reviews every requirement and source with one compact joint pass and reuses cached work", async () => {
    const d = await repo.createOrGetDossier("CO1.REQ.990003");
    const documentIds = ["joint-source-1", "joint-source-2"];
    await repo.save(
      "dossier",
      d.id,
      {
        ...d.value,
        corpusRevision: 1,
        documentIds,
        descriptionId: "joint-description",
        coverage: { inventoryComplete: true },
        needsSynthesis: true,
      },
      d.revision,
    );
    for (const id of documentIds)
      await repo.save(
        "document",
        id,
        {
          dossierId: d.id,
          name: `${id}.pdf`,
          state: "ready",
        },
        0,
      );
    for (let i = 0; i < 213; i++)
      await repo.save(
        "chunk",
        `joint-chunk-${String(i).padStart(3, "0")}`,
        {
          documentVersionId: documentIds[i < 107 ? 0 : 1],
          index: i,
          page: i + 1,
          text: `Requirement ${i}: The bidder must submit signed evidence item ${i} with the offer.${i === 212 ? " FINAL_REQUIREMENT" : ""}`,
        },
        0,
      );
    let jointCalls = 0,
      oldCalls = 0;
    const inputSizes: number[] = [];
    const provider: ModelProvider = {
      id: "compact-joint-fixture",
      async generate(input) {
        inputSizes.push(JSON.stringify(input).length);
        if (input.purpose === "joint_requirement_review") {
          jointCalls++;
          return {
            summary:
              "Todos los requisitos deben revisarse antes de preparar la oferta.",
            candidates: [],
          };
        }
        if (input.purpose === "cross_document_review") oldCalls++;
        return model.generate(input);
      },
    };
    const report = await synthesizeDossier(repo, d.id, 1, provider);
    expect(oldCalls).toBe(0);
    expect(jointCalls).toBe(1);
    expect(Math.max(...inputSizes)).toBeLessThanOrEqual(48000);
    expect(report.coverage.total).toBe(2);
    expect(report.coverage.indexed).toBe(2);
    expect(report.requirementIds).toHaveLength(213);
    expect(report.citations).toHaveLength(213);
    const saved = await Promise.all(
      report.requirementIds.map((id) => repo.read<any>("requirement", id)),
    );
    expect(saved.map((r) => r.value.wording)).toEqual(
      Array.from(
        { length: 213 },
        (_, i) =>
          `Requirement ${i}: The bidder must submit signed evidence item ${i} with the offer.${i === 212 ? " FINAL_REQUIREMENT" : ""}`,
      ),
    );
    expect(
      new Set(
        saved.flatMap((r) =>
          r.value.citations.map((c: any) => c.documentVersionId),
        ),
      ),
    ).toEqual(new Set(documentIds));
    const calls = inputSizes.length;
    await synthesizeDossier(repo, d.id, 1, provider);
    expect(inputSizes).toHaveLength(calls);
    const sourceToReview = await repo.read<any>("document", documentIds[0]);
    await repo.save(
      "document",
      documentIds[0],
      { ...sourceToReview.value, state: "review_required", warnings: [] },
      sourceToReview.revision,
    );

    let checklistModelCalls = 0;
    const checklistAnswer = await answerTenderQuestion(
      repo,
      {
        dossierId: d.id,
        expectedRevision: 0,
        message:
          "Enumera todos los requisitos del pliego en una lista completa",
        idempotencyKey: "complete-checklist-213",
      },
      {
        ...provider,
        async generate(input) {
          if (input.purpose === "tender_conversation") checklistModelCalls++;
          return model.generate(input);
        },
      },
    );
    expect(checklistModelCalls).toBe(0);
    expect(checklistAnswer.checklist?.coverage).toMatchObject({
      requirements: 213,
      citedRequirements: 213,
      inventoryComplete: true,
      listedDocuments: 2,
      reviewRequiredDocuments: 1,
      unavailableDocuments: 0,
    });
    expect(checklistAnswer.checklist?.items).toHaveLength(213);
    expect(checklistAnswer.checklist?.items[0].wording).toContain(
      "Requirement 0:",
    );
    expect(checklistAnswer.checklist?.items[212].wording).toContain(
      "FINAL_REQUIREMENT",
    );
    expect(checklistAnswer.answer).toContain("R213");
    expect(checklistAnswer.answer).toContain("FINAL_REQUIREMENT");
    expect(checklistAnswer.answerMarkdown).toBe(checklistAnswer.answer);
    expect(checklistAnswer.answerMarkdown).toContain("S213");
    expect(checklistAnswer.answerMarkdown).toContain("### Experiencia (213)");
    expect(checklistAnswer.answerMarkdown).not.toContain("### R213");
    const lastCitation = checklistAnswer.checklist?.items[212].citations[0];
    expect(
      checklistAnswer.checklist?.sources.find(
        (source) => source.reference === lastCitation?.sourceRef,
      )?.excerpt,
    ).toBe(checklistAnswer.checklist?.items[212].wording);
    const compactRender = renderExhaustiveChecklist(
      checklistAnswer.checklist!,
      { includeSourceExcerpts: false },
    );
    expect(compactRender).not.toContain("Fragmentos de las fuentes");
    expect(compactRender).toContain("R213");
    expect(
      new Set(
        checklistAnswer.checklist?.sources.map(
          (source) => source.documentVersionId,
        ),
      ),
    ).toEqual(new Set(documentIds));
    expect(checklistAnswer.answer).not.toContain("Confidential");
    expect(checklistAnswer.answer).toContain(
      "No hay un perfil de empresa asociado",
    );
    const reloadedChecklist = await readConversation(
      repo,
      checklistAnswer.conversationId,
    );
    expect(
      (reloadedChecklist.turns[0].value as any).checklist.items,
    ).toHaveLength(213);

    const currentReport = await repo.read<any>("report", `${d.id}:1`);
    await repo.save(
      "report",
      currentReport.id,
      { ...currentReport.value, corpusRevision: 2 },
      currentReport.revision,
    );
    await expect(
      answerTenderQuestion(
        repo,
        {
          dossierId: d.id,
          expectedRevision: 0,
          message: "List every requirement in the tender",
          idempotencyKey: "complete-checklist-stale-report",
        },
        provider,
      ),
    ).rejects.toMatchObject({ code: "CHECKLIST_STALE_REPORT" });

    await repo.save(
      "report",
      currentReport.id,
      { ...currentReport.value, corpusRevision: 1 },
      currentReport.revision + 1,
    );
    const firstRequirement = report.requirementIds[0];
    const savedFirstRequirement = await repo.read<any>(
      "requirement",
      firstRequirement,
    );
    await repo.save(
      "requirement",
      firstRequirement,
      { ...savedFirstRequirement.value, corpusRevision: 2 },
      savedFirstRequirement.revision,
    );
    await expect(
      answerTenderQuestion(
        repo,
        {
          dossierId: d.id,
          expectedRevision: 0,
          message: "Enumera todos los requisitos",
          idempotencyKey: "complete-checklist-stale-requirement",
        },
        provider,
      ),
    ).rejects.toMatchObject({ code: "CHECKLIST_STALE_REQUIREMENT" });
    await repo.save(
      "requirement",
      firstRequirement,
      savedFirstRequirement.value,
      savedFirstRequirement.revision + 1,
    );
    for (const id of report.requirementIds) {
      const record = await repo.read<any>("requirement", id);
      await repo.save(
        "requirement",
        id,
        { ...record.value, wording: "X".repeat(4000) },
        record.revision,
      );
    }
    await expect(
      answerTenderQuestion(
        repo,
        {
          dossierId: d.id,
          expectedRevision: 0,
          message: "List all requirements completely",
          idempotencyKey: "complete-checklist-output-limit",
        },
        provider,
      ),
    ).rejects.toMatchObject({ code: "CHECKLIST_OUTPUT_LIMIT", status: 413 });
  // This integration fixture persists 213 records and exercises several replay paths.
  // Its timeout is an I/O allowance, not a performance assertion.
  }, 60000);
});
