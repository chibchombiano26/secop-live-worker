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
let mf: Miniflare, repo: DossierRepository;
let now = Date.parse("2026-10-15T12:00:00Z");
const model: ModelProvider = {
  id: "fixture-model",
  async generate(input) {
    const c = input.evidence[0];
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
        return {
          answer: "The tender requires experience certificates.",
          insufficientEvidence: false,
          citations: [
            {
              documentVersionId: c.documentVersionId,
              page: c.page,
              section: c.section,
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
});
