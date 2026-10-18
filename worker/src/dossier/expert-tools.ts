import { DossierError } from "./contracts";
import { readStudyJob } from "./agent-scope";
import { authorizeExpertActions, type ExpertAction } from "./expert-policy";
import {
  expertSnapshot,
  readExpertState,
  commitExpertEffect,
  planSchema,
  type ExpertScope,
  type ExpertPlan,
  type ExpertSnapshot,
} from "./expert-state";
import { dossierEvidence, type Requirement } from "./synthesis";
import { buildExhaustiveChecklist } from "./checklist";
import { assessCompany, normalizeFinding } from "./assessment";
import { companyEvidence } from "./companies";
import type { ModelProvider } from "./model";
import type { DossierRepository } from "./repository";
export function createExpertTools(
  repo: DossierRepository,
  scope: ExpertScope,
  model: ModelProvider,
  options: { snapshot?: ExpertSnapshot } = {},
) {
  async function assertSnapshot() {
    const current = await expertSnapshot(repo, scope);
    if (
      options.snapshot &&
      JSON.stringify(options.snapshot) !== JSON.stringify(current)
    )
      throw new DossierError("EXPERT_SNAPSHOT_CHANGED", 409);
    return options.snapshot ?? current;
  }
  async function authorize(action: ExpertAction) {
    if (scope.ownerId !== repo.context.ownerId)
      throw new DossierError("AGENT_CONTEXT_MISMATCH", 403);
    const saved = await readStudyJob(repo, scope);
    if (
      !authorizeExpertActions(
        saved.request.message,
        [action],
        saved.request.authority,
      ).includes(action)
    )
      throw new DossierError("EXPERT_ACTION_FORBIDDEN", 403);
    return saved;
  }
  async function inspectDossier() {
    await authorize("review");
    const dossier = await repo.readDossier(scope.dossierId);
    return {
      snapshot: await expertSnapshot(repo, scope),
      coverage: dossier.value.coverage ?? null,
      needsSynthesis: !!dossier.value.needsSynthesis,
      companySelected: !!scope.companyProfileId,
    };
  }
  async function reviewRequirements() {
    await authorize("review");
    const { dossier, chunks } = await dossierEvidence(repo, scope.dossierId);
    if (!dossier.value.reportId || dossier.value.needsSynthesis)
      throw new DossierError("REPORT_REQUIRED", 409);
    const report = await repo.read<Record<string, unknown>>(
      "report",
      String(dossier.value.reportId),
    );
    const company = scope.companyProfileId
      ? await companyEvidence(repo, scope.companyProfileId)
      : null;
    return buildExhaustiveChecklist(
      repo,
      scope.dossierId,
      Number(dossier.value.corpusRevision),
      String(dossier.value.reportId),
      report.value,
      chunks,
      company,
    );
  }
  async function evaluateCompany() {
    if (!scope.companyProfileId) {
      await authorize("review");
      return null;
    }
    await authorize("evaluate_company");
    await assertSnapshot();
    const result = await assessCompany(
      repo,
      scope.dossierId,
      scope.companyProfileId,
      [],
      model,
      { createTasks: false },
    );
    await authorize("evaluate_company");
    await assertSnapshot();
    return result;
  }
  async function buildPreparationPlan(
    assessment?: Awaited<ReturnType<typeof assessCompany>> | null,
  ): Promise<ExpertPlan> {
    const snapshot = await assertSnapshot();
    const saved = await authorize("review"),
      checklist = await reviewRequirements();
    if (assessment) {
      if (
        assessment.dossierId !== snapshot.dossierId ||
        assessment.companyId !== snapshot.companyProfileId ||
        assessment.corpusRevision !== snapshot.corpusRevision ||
        assessment.companyRevision !== snapshot.companyRevision
      )
        throw new DossierError("EXPERT_SNAPSHOT_CHANGED", 409);
      const company = await companyEvidence(repo, assessment.companyId);
      const unusable = new Set([
        ...company.expired,
        ...company.docs
          .filter((d) => d.value.state !== "ready")
          .map((d) => d.id),
      ]);
      const requirements = await repo.readMany<Requirement>(
        "requirement",
        assessment.findings.map((f) => f.requirementId),
      );
      assessment.findings = assessment.findings.map((finding, index) => ({
        ...finding,
        ...normalizeFinding(
          requirements[index].value,
          finding,
          company.chunks,
          unusable,
          assessment.selectedLots ?? [],
        ),
      }));
      if (unusable.size) assessment.readiness = "requires_review";
    }
    const prior = await readExpertState(repo, scope);
    const items = checklist.items.flatMap((item) => {
      const finding = assessment?.findings.find(
        (f) => f.requirementId === item.requirementId,
      );
      if (finding && ["meets", "not_applicable"].includes(finding.status))
        return [];
      const old = prior.plan?.value.items.find(
        (i) => i.requirementId === item.requirementId,
      );
      return [
        {
          requirementId: item.requirementId,
          sourceRefs: item.citations.map((c) => c.sourceRef),
          status: finding?.status ?? ("insufficient_evidence" as const),
          nextAction: finding
            ? finding.missing.join("; ") || finding.reason
            : `Reunir y verificar el soporte empresarial de: ${item.wording}`,
          owner: old?.owner ?? null,
          dueDate: old?.dueDate ?? null,
        },
      ];
    });
    await assertSnapshot();
    if (checklist.corpusRevision !== snapshot.corpusRevision)
      throw new DossierError("EXPERT_SNAPSHOT_CHANGED", 409);
    return {
      snapshot,
      originatingTurnId: saved.job.targetId,
      items,
    };
  }
  async function savePlan(
    plan: ExpertPlan,
    operationId: string,
    expectedRevision: number,
  ) {
    await authorize("save_plan");
    const snapshot = await assertSnapshot();
    if (JSON.stringify(plan.snapshot) !== JSON.stringify(snapshot))
      throw new DossierError("EXPERT_SNAPSHOT_CHANGED", 409);
    const parsed = planSchema.parse(plan),
      checklist = await reviewRequirements();
    for (const item of parsed.items) {
      const requirement = checklist.items.find(
        (r) => r.requirementId === item.requirementId,
      );
      if (
        !requirement ||
        item.sourceRefs.some(
          (ref) => !requirement.citations.some((c) => c.sourceRef === ref),
        )
      )
        throw new DossierError("EXPERT_PLAN_SOURCE_MISMATCH", 403);
    }
    return commitExpertEffect(repo, scope, {
      operationId,
      snapshot: parsed.snapshot,
      kind: "plan",
      value: parsed,
      expectedRevision,
    });
  }
  async function prepareProposal() {
    await authorize("prepare_proposal");
    await reviewRequirements();
    await assertSnapshot();
    return {
      actionId: "proposal-docx",
      status: "ready_for_host_action" as const,
      note: "Usa la acción de propuesta del chat para abrir el borrador existente o guardarlo en Office. No se ha reemplazado ningún archivo.",
    };
  }
  async function rememberDecision(operationId: string) {
    const { request, job } = await authorize("remember_decision"),
      state = await readExpertState(repo, scope),
      snapshot = await assertSnapshot();
    const value = {
      snapshot,
      decisions: [
        ...(state.memory?.value.decisions ?? []).filter(
          (d) => d.originatingTurnId !== job.targetId,
        ),
        { text: request.message, originatingTurnId: job.targetId },
      ],
      unresolvedQuestions: state.memory?.value.unresolvedQuestions ?? [],
    };
    return commitExpertEffect(repo, scope, {
      operationId,
      snapshot,
      kind: "memory",
      value,
      expectedRevision: state.memory?.revision ?? 0,
    });
  }
  return {
    inspectDossier,
    reviewRequirements,
    evaluateCompany,
    buildPreparationPlan,
    savePlan,
    prepareProposal,
    rememberDecision,
  };
}
