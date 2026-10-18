import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { DossierRepository } from "../src/dossier/repository";
import { PRIVATE_SCOPES } from "../src/dossier/contracts";
import { sha256 } from "../src/dossier/downloads";
export async function expertFixture(
  message = "Evalúa mi empresa y guarda un plan de preparación",
  selectedCompany = true,
  companyHasEvidence = false,
) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DOSSIER_DB"],
      r2Buckets: ["DOSSIER_FILES"],
      compatibilityDate: "2026-10-01",
    }),
  );
  const env: any = {
    DOSSIER_DB: await mf.getD1Database("DOSSIER_DB"),
    DOSSIER_FILES: await mf.getR2Bucket("DOSSIER_FILES"),
  };
  await env.DOSSIER_DB.exec(
    readFileSync(
      new URL("../migrations/0001_dossiers.sql", import.meta.url),
      "utf8",
    ),
  );
  const repo = new DossierRepository(env, {
    ownerId: "expert-owner",
    scopes: [...PRIVATE_SCOPES],
  });
  const dossierId = "CO1.REQ.1",
    reportId = `${dossierId}:1`;
  await repo.save(
    "dossier",
    dossierId,
    {
      corpusRevision: 1,
      reportId,
      needsSynthesis: false,
      state: "analyzed",
      documentIds: ["doc"],
      coverage: { inventoryComplete: true },
    },
    0,
  );
  await repo.save(
    "company",
    "company-a",
    { name: "Company A", activities: "Software", facts: [] },
    0,
  );
  if (companyHasEvidence) {
    await repo.save(
      "document",
      "fixture-company-doc",
      {
        dossierId: "company:company-a",
        name: "Company experience.pdf",
        state: "ready",
      },
      0,
    );
    await repo.save(
      "evidence",
      "fixture-company-evidence",
      { companyId: "company-a", documentId: "fixture-company-doc" },
      0,
    );
    await repo.save(
      "chunk",
      "fixture-company-chunk",
      {
        documentVersionId: "fixture-company-doc",
        page: 1,
        index: 0,
        text: "The company declares one software delivery project.",
      },
      0,
    );
  }
  await repo.save(
    "report",
    reportId,
    {
      dossierId,
      corpusRevision: 1,
      requirementIds: ["r1"],
      summary: "Experiencia verificable",
      conflicts: [],
      coverage: { total: 1, indexed: 1, pending: [], reviewRequired: [] },
    },
    0,
  );
  await repo.save(
    "document",
    "doc",
    { dossierId, name: "Pliego.pdf", state: "ready", kind: "pdf" },
    0,
  );
  const text = "El proponente debe acreditar dos contratos de experiencia.";
  await repo.save(
    "chunk",
    "chunk1",
    { dossierId, documentVersionId: "doc", index: 0, page: 2, text },
    0,
  );
  await repo.save(
    "requirement",
    "r1",
    {
      dossierId,
      corpusRevision: 1,
      wording: text,
      category: "experience",
      mandatory: true,
      lot: null,
      deadline: null,
      rule: null,
      citations: [{ documentVersionId: "doc", page: 2, excerpt: text }],
    },
    0,
  );
  const input = {
    dossierId,
    ...(selectedCompany ? { companyProfileId: "company-a" } : {}),
    message,
    expectedRevision: 0,
    idempotencyKey: "expert-test-request",
  };
  await repo.save(
    "message",
    "request",
    {
      kind: "chat_request",
      ...input,
      authority: {
        scopes: [...PRIVATE_SCOPES],
        requestHash: await sha256(JSON.stringify(input)),
      },
    },
    0,
  );
  const queued = await repo.enqueueJob({
    kind: "chat",
    targetId: "request",
    key: "expert-fixture",
  });
  const job = (await repo.claimJob(queued.id))!;
  const scope = {
    ownerId: repo.context.ownerId,
    dossierId,
    ...(selectedCompany ? { companyProfileId: "company-a" } : {}),
    jobId: job.id,
    lease: job.lease!,
  };
  const snapshot = {
    dossierId,
    corpusRevision: 1,
    reportId,
    companyProfileId: selectedCompany ? "company-a" : null,
    companyRevision: selectedCompany ? 1 : null,
  };
  return { mf, repo, env, scope, snapshot, job };
}
