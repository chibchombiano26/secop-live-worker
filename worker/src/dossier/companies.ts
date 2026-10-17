import { z } from "zod/v4";
import { DossierError } from "./contracts";
import { DossierRepository } from "./repository";
import { citationSchema, validateCitations } from "./synthesis";
import type { EvidenceChunk } from "./extraction";
import type { DocumentVersion } from "./inventory";
export const factSchema = z.object({
  field: z.string().min(1).max(200),
  value: z.number().finite(),
  unit: z.string().min(1).max(100),
  period: z.string().max(100).nullable(),
  citations: z.array(citationSchema).max(10),
  reviewed: z.boolean().default(false),
});
export type CompanyFact = z.infer<typeof factSchema>;
export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    legalId: z.string().max(100).default(""),
    activities: z.string().max(4000).default(""),
    facts: z.array(factSchema).max(200).default([]),
  })
  .strict();
export type CompanyProfile = z.infer<typeof profileSchema> & {
  evidenceChangedAt?: number;
};
export async function companyEvidence(
  repo: DossierRepository,
  companyId: string,
) {
  const company = await repo.read<CompanyProfile>("company", companyId);
  const evidence = await repo.allMatching<{
    companyId: string;
    documentId: string;
    expiresOn?: string;
  }>("evidence", "companyId", [companyId]);
  const docs = await Promise.all(
    evidence.map((e) =>
      repo.read<DocumentVersion & { expiresOn?: string }>(
        "document",
        e.value.documentId,
      ),
    ),
  );
  const ids = new Set(
    docs
      .filter((d) => ["ready", "review_required"].includes(d.value.state))
      .map((d) => d.id),
  );
  const chunks = (
    await repo.allMatching<EvidenceChunk>("chunk", "documentVersionId", [
      ...ids,
    ])
  ).map((c) => c.value);
  const expired = new Set(
    docs
      .filter(
        (d) =>
          d.value.expiresOn &&
          Date.parse(`${d.value.expiresOn}T23:59:59Z`) < repo.now(),
      )
      .map((d) => d.id),
  );
  return { company, docs, chunks, expired };
}
export async function saveCompanyProfile(
  repo: DossierRepository,
  input: unknown,
  expectedRevision: number,
  id?: string,
) {
  const profile = profileSchema.parse(input);
  return repo.save(
    "company",
    id ?? crypto.randomUUID(),
    {
      ...profile,
      facts: profile.facts.map((f) => ({ ...f, reviewed: false })),
    },
    expectedRevision,
  );
}
export async function reviewCompanyFact(
  repo: DossierRepository,
  companyId: string,
  index: number,
  note: string,
  expectedRevision: number,
) {
  if (note.trim().length < 3 || note.length > 2000)
    throw new DossierError("REVIEW_NOTE_REQUIRED");
  const { company, chunks, expired } = await companyEvidence(repo, companyId);
  if (company.revision !== expectedRevision)
    throw new DossierError("REVISION_CONFLICT", 409);
  const fact = company.value.facts[index];
  if (!fact) throw new DossierError("FACT_NOT_FOUND", 404);
  fact.citations = validateCitations(fact.citations, chunks);
  if (fact.citations.some((c) => expired.has(c.documentVersionId)))
    throw new DossierError("EVIDENCE_EXPIRED", 409);
  const facts = company.value.facts.map((f, i) =>
    i === index ? { ...f, reviewed: true } : f,
  );
  const updated = await repo.save(
    "company",
    companyId,
    { ...company.value, facts },
    expectedRevision,
  );
  await repo.save(
    "review",
    crypto.randomUUID(),
    {
      kind: "company_fact",
      companyId,
      index,
      note,
      revision: updated.revision,
      at: repo.now(),
      actor: "authorized_connection",
    },
    0,
  );
  return updated;
}
