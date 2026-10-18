import { z } from "zod/v4";
import { DossierError } from "./contracts";
import { DossierRepository } from "./repository";
import {
  citationSchema,
  validateCitations,
  type Requirement,
} from "./synthesis";
import { companyEvidence, type CompanyFact } from "./companies";
import type { EvidenceChunk } from "./extraction";
import type { ModelProvider } from "./model";
import { sha256 } from "./downloads";
export const findingSchema = z.object({
  status: z.enum([
    "meets",
    "does_not_meet",
    "insufficient_evidence",
    "not_applicable",
  ]),
  reason: z.string().min(1).max(5000),
  missing: z.array(z.string().max(1000)).max(30),
  companyCitations: z.array(citationSchema).max(30),
});
export type Finding = z.infer<typeof findingSchema>;
export function compareNumericRule(
  rule: NonNullable<Requirement["rule"]>,
  fact: CompanyFact,
): Finding["status"] {
  if (
    !fact.reviewed ||
    !fact.citations.length ||
    fact.field !== rule.field ||
    fact.unit !== rule.unit ||
    fact.period !== rule.period
  )
    return "insufficient_evidence";
  const result =
    rule.operator === "gte"
      ? fact.value >= rule.value
      : rule.operator === "lte"
        ? fact.value <= rule.value
        : fact.value === rule.value;
  return result ? "meets" : "does_not_meet";
}
export function normalizeFinding(
  requirement: Requirement,
  value: unknown,
  chunks: EvidenceChunk[],
  expired: Set<string>,
  selectedLots: string[],
): Finding {
  const finding = findingSchema.parse(value);
  if (finding.companyCitations.length)
    finding.companyCitations = validateCitations(
      finding.companyCitations,
      chunks,
    );
  if (
    requirement.lot &&
    selectedLots.length &&
    !selectedLots.includes(requirement.lot)
  )
    return {
      ...finding,
      status: "not_applicable",
      reason: "The requirement belongs to a lot the user did not select.",
    };
  if (finding.status === "not_applicable")
    return {
      ...finding,
      status: "insufficient_evidence",
      reason:
        "Applicability requires a documented lot selection or explicit user review.",
    };
  if (
    ["meets", "does_not_meet"].includes(finding.status) &&
    (!finding.companyCitations.length ||
      finding.companyCitations.some((c) => expired.has(c.documentVersionId)))
  )
    return {
      ...finding,
      status: "insufficient_evidence",
      reason: "Missing or expired supporting company evidence.",
      missing: [
        ...finding.missing,
        "Provide current evidence for this requirement.",
      ],
    };
  return finding;
}
export function assessmentReadiness(
  findings: Array<{ mandatory: boolean; status: string }>,
  complete: boolean,
  conflicts: boolean,
) {
  if (!complete || conflicts || !findings.length) return "requires_review";
  if (
    findings.some(
      (f) => f.mandatory && !["meets", "not_applicable"].includes(f.status),
    )
  )
    return "missing_requirements";
  return "ready_for_user_review";
}
export async function assessCompany(
  repo: DossierRepository,
  dossierId: string,
  companyId: string,
  selectedLots: string[],
  model: ModelProvider,
  options: { createTasks?: boolean } = {},
) {
  const dossier = await repo.readDossier(dossierId);
  if (!dossier.value.reportId || dossier.value.needsSynthesis)
    throw new DossierError("REPORT_REQUIRED", 409);
  const report = await repo.read<{
    corpusRevision: number;
    requirementIds: string[];
    coverage: {
      total: number;
      indexed: number;
      pending: unknown[];
      reviewRequired: string[];
    };
    conflicts: string[];
  }>("report", String(dossier.value.reportId));
  if (report.value.corpusRevision !== dossier.value.corpusRevision)
    throw new DossierError("REPORT_STALE", 409);
  const company = await companyEvidence(repo, companyId);
  const unverifiedEvidence = new Set([
    ...company.expired,
    ...company.docs.filter((d) => d.value.state !== "ready").map((d) => d.id),
  ]);
  const companyRevision = company.company.revision,
    corpusRevision = report.value.corpusRevision;
  const allRequirements = await Promise.all(
    report.value.requirementIds.map((id) =>
      repo.read<Requirement>("requirement", id),
    ),
  );
  const knownLots = new Set(
    allRequirements.map((r) => r.value.lot).filter(Boolean),
  );
  if (selectedLots.some((lot) => !knownLots.has(lot)))
    throw new DossierError("INVALID_LOT_SELECTION", 422);
  const findings: Array<
    Finding & { requirementId: string; mandatory: boolean }
  > = [];
  for (const requirementId of report.value.requirementIds) {
    const req = (await repo.read<Requirement>("requirement", requirementId))
      .value;
    const cacheId = await sha256(
      `assessment:${dossierId}:${corpusRevision}:${companyId}:${companyRevision}:${requirementId}:${JSON.stringify(selectedLots)}:${model.id}`,
    );
    let cached: unknown;
    try {
      cached = (await repo.read("assessment", `part.${cacheId}`)).value;
    } catch (e) {
      if (!(e instanceof DossierError) || e.code !== "NOT_FOUND") throw e;
    }
    let finding: Finding;
    if (!company.chunks.length) {
      finding = {
        status: "insufficient_evidence",
        reason:
          "No hay documentos de empresa con texto extraído. Las capacidades declaradas en el perfil no acreditan este requisito.",
        missing: [
          "Aportar soporte vigente del requisito indicado y contrastarlo con el original.",
        ],
        companyCitations: [],
      };
    } else if (cached) finding = findingSchema.parse(cached);
    else {
      const words = new Set(
        req.wording
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3),
      );
      const ranked = company.chunks
        .map((c) => ({
          chunk: c,
          score: [...words].filter((w) => c.text.toLowerCase().includes(w))
            .length,
        }))
        .sort((a, b) => b.score - a.score);
      const evidence = ranked.slice(0, 6).map((c) => c.chunk);
      const raw = await model.generate({
        purpose: "company_fit",
        outputSchema: z.toJSONSchema(findingSchema),
        evidence,
        context: {
          requirement: req,
          companyAssertions: {
            name: company.company.value.name,
            activities: company.company.value.activities,
          },
          selectedLots,
          expiredDocumentIds: [...company.expired],
        },
        instructions:
          "Return {status:meets|does_not_meet|insufficient_evidence|not_applicable,reason,missing:string[],companyCitations:[{documentVersionId,page?,section?,excerpt}]}. Evaluate only this stated requirement. Company profile assertions are not verified evidence. Missing, expired, unreadable, mismatched fiscal period or contradictory support must be insufficient_evidence. Give specific missing evidence/actions. Do not infer compliance from absence of evidence.",
      });
      finding = normalizeFinding(
        req,
        raw,
        evidence,
        unverifiedEvidence,
        selectedLots,
      );
      if (req.rule) {
        const fact = company.company.value.facts.find(
          (f) =>
            f.field === req.rule!.field &&
            f.period === req.rule!.period &&
            f.unit === req.rule!.unit,
        );
        if (
          !fact ||
          fact.citations.some((c) =>
            unverifiedEvidence.has(c.documentVersionId),
          )
        )
          finding = {
            ...finding,
            status: "insufficient_evidence",
            missing: [
              ...finding.missing,
              "Review a cited numeric fact with matching unit and fiscal period.",
            ],
          };
        else {
          fact.citations = validateCitations(fact.citations, company.chunks);
          finding = {
            ...finding,
            status: compareNumericRule(req.rule, fact),
            companyCitations: fact.citations,
            reason: `Deterministic ${req.rule.field} comparison (${fact.value} ${req.rule.operator} ${req.rule.value}); fact reviewed by user.`,
          };
        }
      }
      await repo.upsert("assessment", `part.${cacheId}`, finding);
    }
    // Revalidate cached findings too: extraction/expiry may change without the old cache key.
    finding = normalizeFinding(
      req,
      finding,
      company.chunks,
      unverifiedEvidence,
      selectedLots,
    );
    findings.push({ ...finding, requirementId, mandatory: req.mandatory });
  }
  const latestCompany = await repo.read("company", companyId),
    latestDossier = await repo.readDossier(dossierId);
  if (
    latestCompany.revision !== companyRevision ||
    latestDossier.value.corpusRevision !== corpusRevision ||
    latestDossier.value.needsSynthesis
  )
    throw new DossierError("ASSESSMENT_INPUT_CHANGED", 409);
  const id = await sha256(
    `${dossierId}:${corpusRevision}:${companyId}:${companyRevision}:${JSON.stringify(selectedLots)}`,
  );
  const complete =
    report.value.coverage.total > 0 &&
    !report.value.coverage.pending.length &&
    !report.value.coverage.reviewRequired.length &&
    company.docs.every((d) => d.value.state === "ready");
  const result = {
    dossierId,
    companyId,
    corpusRevision,
    companyRevision,
    selectedLots,
    model: model.id,
    generatedAt: repo.now(),
    coverageComplete: complete,
    hasConflicts: report.value.conflicts.length > 0 || company.expired.size > 0,
    findings,
    readiness: assessmentReadiness(
      findings,
      complete,
      report.value.conflicts.length > 0 || company.expired.size > 0,
    ),
  };
  await repo.upsert("assessment", id, result);
  for (const f of (options.createTasks === false ? [] : findings).filter(
    (f) => !["meets", "not_applicable"].includes(f.status),
  )) {
    const taskId = `${id}.${f.requirementId}`;
    try {
      await repo.save(
        "task",
        taskId,
        {
          assessmentId: id,
          dossierId,
          requirementId: f.requirementId,
          description: f.missing.join("\n") || f.reason,
          owner: null,
          dueDate: null,
          state: "pending",
        },
        0,
      );
    } catch (error) {
      if (
        !(error instanceof DossierError) ||
        error.code !== "REVISION_CONFLICT"
      )
        throw error;
    }
  }
  return { id, ...result };
}
export async function readAssessment(repo: DossierRepository, id: string) {
  const stored = await repo.read<{
    companyId: string;
    companyRevision: number;
    dossierId: string;
    corpusRevision: number;
    findings: Array<Finding & { requirementId: string; mandatory: boolean }>;
    readiness: string;
    coverageComplete?: boolean;
    hasConflicts?: boolean;
  }>("assessment", id);
  const company = await companyEvidence(repo, stored.value.companyId);
  const dossier = await repo.readDossier(stored.value.dossierId);
  const stale =
    company.company.revision !== stored.value.companyRevision ||
    dossier.value.corpusRevision !== stored.value.corpusRevision ||
    Boolean(dossier.value.needsSynthesis) ||
    company.expired.size > 0;
  const allReviews = await repo.all<{
    assessmentId: string;
    dossierId?: string;
    companyId?: string;
    requirementId: string;
    decision: string;
    note: string;
    at: number;
    companyRevision?: number;
    requirementFingerprint?: string;
  }>("review");
  const reviews = allReviews.filter((r) => r.value.assessmentId === id);
  const priorReviews = allReviews.filter(
    (r) =>
      r.value.assessmentId !== id &&
      r.value.dossierId === stored.value.dossierId &&
      r.value.companyId === stored.value.companyId,
  );
  const effectiveFindings = await Promise.all(
    stored.value.findings.map(async (f) => {
      const requirement = await repo.read<Requirement>(
        "requirement",
        f.requirementId,
      );
      const fingerprint = await sha256(JSON.stringify(requirement.value));
      const review = [...reviews, ...priorReviews]
        .filter(
          (r) =>
            r.value.requirementId === f.requirementId &&
            r.value.companyRevision === stored.value.companyRevision &&
            r.value.requirementFingerprint === fingerprint,
        )
        .sort((a, b) => b.value.at - a.value.at)[0];
      return review
        ? {
            ...f,
            modelStatus: f.status,
            modelReason: f.reason,
            status: review.value.decision as Finding["status"],
            reason: review.value.note,
            userReview: review.value,
          }
        : f;
    }),
  );
  const readiness = stale
    ? "requires_review"
    : assessmentReadiness(
        effectiveFindings,
        stored.value.coverageComplete ?? false,
        stored.value.hasConflicts ?? true,
      );
  return {
    ...stored,
    value: { ...stored.value, findings: effectiveFindings, readiness },
    stale,
    readiness,
    reviews,
    priorReviews,
    effectiveFindings,
  };
}
export async function reviewFinding(
  repo: DossierRepository,
  assessmentId: string,
  requirementId: string,
  decision: Finding["status"],
  note: string,
  expectedRevision: number,
) {
  const assessment = await readAssessment(repo, assessmentId);
  if (assessment.revision !== expectedRevision)
    throw new DossierError("REVISION_CONFLICT", 409);
  if (
    !assessment.value.findings.some((f) => f.requirementId === requirementId) ||
    note.trim().length < 3 ||
    note.length > 2000
  )
    throw new DossierError("INVALID_REVIEW");
  if (assessment.stale) throw new DossierError("ASSESSMENT_INPUT_CHANGED", 409);
  const raw = await repo.read<Record<string, unknown>>(
    "assessment",
    assessmentId,
  );
  const requirement = await repo.read<Requirement>(
    "requirement",
    requirementId,
  );
  const requirementFingerprint = await sha256(
    JSON.stringify(requirement.value),
  );
  const id = crypto.randomUUID();
  const updated = await repo.save(
    "assessment",
    assessmentId,
    { ...raw.value, lastReviewId: id },
    expectedRevision,
  );
  await repo.save(
    "review",
    id,
    {
      assessmentId,
      dossierId: assessment.value.dossierId,
      companyId: assessment.value.companyId,
      requirementId,
      requirementFingerprint,
      decision,
      note,
      at: repo.now(),
      companyRevision: assessment.value.companyRevision,
      corpusRevision: assessment.value.corpusRevision,
      actor: "authorized_connection",
    },
    0,
  );
  return updated;
}
