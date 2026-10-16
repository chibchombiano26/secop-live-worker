import { DossierError } from "./contracts";
import type { DossierRepository } from "./repository";
import type { EvidenceChunk } from "./extraction";
import type { Requirement } from "./synthesis";
import { requirementSchema, validateCitations } from "./synthesis";

const MAX_CHECKLIST_CHARS = 500_000;

export type ChecklistCitation = {
  sourceRef: string;
  documentVersionId: string;
  documentName: string;
  page?: number;
  section?: string;
};

export type ExhaustiveChecklist = {
  dossierId: string;
  corpusRevision: number;
  coverage: {
    requirements: number;
    citedRequirements: number;
    inventoryComplete: boolean;
    listedDocuments: number;
    reviewRequiredDocuments: number;
    unavailableDocuments: number;
  };
  items: Array<{
    reference: string;
    requirementId: string;
    wording: string;
    category: Requirement["category"];
    mandatory: boolean;
    lot: string | null;
    deadline: string | null;
    rule: Requirement["rule"];
    deadlineStatus: "past" | "upcoming" | null;
    citations: ChecklistCitation[];
  }>;
  sources: Array<{
    reference: string;
    documentVersionId: string;
    documentName: string;
    page?: number;
    section?: string;
    excerpt: string;
  }>;
  evidenceGaps: Array<{
    documentVersionId: string;
    documentName: string;
    state: string;
    warnings: string[];
    error?: string;
  }>;
  companyEvidence: {
    profileAttached: boolean;
    documents: Array<{
      documentVersionId: string;
      documentName: string;
      state: string;
      expired: boolean;
    }>;
    note: string;
  };
  cautions: string[];
};

/** Recognize explicit requests for a complete, tender-wide requirements list. */
export function isExhaustiveChecklistRequest(message: string) {
  const normalized = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
  return (
    (/\b(?:todos?|todas?|cada|completo|completa|exhaustive|every|all)\b/u.test(
      normalized,
    ) ||
      /\bchecklist\b/u.test(normalized)) &&
    /\b(?:requisitos?|obligaciones?|requirements?|obligations?|checklist|lista de verificacion)\b/u.test(
      normalized,
    )
  );
}

function fail(code: string, status = 409): never {
  throw new DossierError(code, status);
}

/**
 * Build a deterministic, complete view of the saved extraction records. The
 * report is used only as an ordered index; every record and source span is
 * checked against the current dossier corpus before returning it.
 */
export async function buildExhaustiveChecklist(
  repo: DossierRepository,
  dossierId: string,
  corpusRevision: number,
  reportId: string,
  report: Record<string, unknown>,
  chunks: EvidenceChunk[],
  company: {
    docs: Array<{ id: string; value: Record<string, unknown> }>;
    expired: Set<string>;
  } | null,
): Promise<ExhaustiveChecklist> {
  if (
    reportId !== `${dossierId}:${corpusRevision}` ||
    report.dossierId !== dossierId ||
    report.corpusRevision !== corpusRevision ||
    !Array.isArray(report.requirementIds)
  )
    fail("CHECKLIST_STALE_REPORT");

  const requirementIds = report.requirementIds as unknown[];
  const requirements: ExhaustiveChecklist["items"] = [];
  const sourceByKey = new Map<string, ExhaustiveChecklist["sources"][number]>();
  const docs = new Map<
    string,
    { name: string; state: string; warnings: string[]; error?: string }
  >();
  const dossier = await repo.readDossier(dossierId);
  for (const id of (dossier.value.documentIds ?? []) as string[]) {
    try {
      const doc = await repo.read<Record<string, unknown>>("document", id);
      docs.set(id, {
        name:
          typeof doc.value.name === "string"
            ? doc.value.name
            : "Documento sin nombre",
        state:
          typeof doc.value.state === "string" ? doc.value.state : "unknown",
        warnings: Array.isArray(doc.value.warnings)
          ? doc.value.warnings.filter((x): x is string => typeof x === "string")
          : [],
        ...(typeof doc.value.error === "string"
          ? { error: doc.value.error }
          : {}),
      });
    } catch (error) {
      if (error instanceof DossierError && error.code === "NOT_FOUND")
        fail("CHECKLIST_STALE_SOURCE");
      throw error;
    }
  }
  if (typeof dossier.value.descriptionId === "string") {
    try {
      const doc = await repo.read<Record<string, unknown>>(
        "document",
        dossier.value.descriptionId,
      );
      docs.set(doc.id, {
        name:
          typeof doc.value.name === "string"
            ? doc.value.name
            : "Descripción oficial del proceso",
        state:
          typeof doc.value.state === "string" ? doc.value.state : "unknown",
        warnings: Array.isArray(doc.value.warnings)
          ? doc.value.warnings.filter((x): x is string => typeof x === "string")
          : [],
        ...(typeof doc.value.error === "string"
          ? { error: doc.value.error }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof DossierError) || error.code !== "NOT_FOUND")
        throw error;
    }
  }

  for (let index = 0; index < requirementIds.length; index++) {
    const rawId = requirementIds[index];
    if (
      typeof rawId !== "string" ||
      !rawId ||
      requirementIds.indexOf(rawId) !== index
    )
      fail("CHECKLIST_INVALID_REPORT");
    let stored;
    try {
      stored = await repo.read<Record<string, unknown>>("requirement", rawId);
    } catch (error) {
      if (error instanceof DossierError && error.code === "NOT_FOUND")
        fail("CHECKLIST_STALE_REQUIREMENT");
      throw error;
    }
    const record = stored.value;
    if (
      record.dossierId !== dossierId ||
      record.corpusRevision !== corpusRevision
    )
      fail("CHECKLIST_STALE_REQUIREMENT");
    let requirement: Requirement;
    try {
      requirement = requirementSchema.parse(record);
    } catch {
      fail("CHECKLIST_INVALID_REQUIREMENT");
    }
    const citations = validateCitations(requirement.citations, chunks);
    const itemCitations: ChecklistCitation[] = citations.map((citation) => {
      const key = JSON.stringify(citation);
      let source = sourceByKey.get(key);
      if (!source) {
        const reference = `S${String(sourceByKey.size + 1).padStart(3, "0")}`;
        source = {
          reference,
          documentVersionId: citation.documentVersionId,
          documentName:
            docs.get(citation.documentVersionId)?.name ??
            (citation.documentVersionId.startsWith("description:")
              ? "Descripción oficial del proceso"
              : "Fuente del expediente"),
          ...(citation.page ? { page: citation.page } : {}),
          ...(citation.section ? { section: citation.section } : {}),
          excerpt: citation.excerpt,
        };
        sourceByKey.set(key, source);
      }
      return {
        sourceRef: source.reference,
        documentVersionId: source.documentVersionId,
        documentName: source.documentName,
        ...(source.page ? { page: source.page } : {}),
        ...(source.section ? { section: source.section } : {}),
      };
    });
    requirements.push({
      reference: `R${String(index + 1).padStart(3, "0")}`,
      requirementId: rawId,
      wording: requirement.wording,
      category: requirement.category,
      mandatory: requirement.mandatory,
      lot: requirement.lot,
      deadline: requirement.deadline,
      deadlineStatus: requirement.deadline
        ? (() => {
            const deadlineMs = Date.parse(
              /^\d{4}-\d{2}-\d{2}$/u.test(requirement.deadline!)
                ? `${requirement.deadline}T23:59:59Z`
                : requirement.deadline!,
            );
            return Number.isFinite(deadlineMs)
              ? deadlineMs < repo.now()
                ? "past"
                : "upcoming"
              : null;
          })()
        : null,
      rule: requirement.rule,
      citations: itemCitations,
    });
  }

  const evidenceGaps = [...docs.entries()]
    .filter(([, doc]) => doc.state !== "ready" || doc.warnings.length > 0)
    .map(([documentVersionId, doc]) => ({
      documentVersionId,
      documentName: doc.name,
      state: doc.state,
      warnings: doc.warnings,
      ...(doc.error ? { error: doc.error } : {}),
    }));
  const inventoryComplete = Boolean(
    (dossier.value.coverage as { inventoryComplete?: unknown } | undefined)
      ?.inventoryComplete,
  );
  const companyDocuments = (company?.docs ?? []).map((doc) => ({
    documentVersionId: doc.id,
    documentName:
      typeof doc.value.name === "string"
        ? doc.value.name
        : "Documento de empresa sin nombre",
    state: typeof doc.value.state === "string" ? doc.value.state : "unknown",
    expired: company?.expired.has(doc.id) ?? false,
  }));
  const checklist: ExhaustiveChecklist = {
    dossierId,
    corpusRevision,
    coverage: {
      requirements: requirements.length,
      citedRequirements: requirements.filter(
        (item) => item.citations.length > 0,
      ).length,
      inventoryComplete,
      listedDocuments: docs.size,
      reviewRequiredDocuments: [...docs.values()].filter(
        (doc) => doc.state === "review_required",
      ).length,
      unavailableDocuments: [...docs.values()].filter(
        (doc) => !["ready", "review_required"].includes(doc.state),
      ).length,
    },
    items: requirements,
    sources: [...sourceByKey.values()],
    evidenceGaps,
    companyEvidence: {
      profileAttached: company !== null,
      documents: companyDocuments,
      note: company
        ? companyDocuments.length
          ? "La evidencia de la empresa requiere revisión humana; los documentos de la licitación no prueban por sí solos su cumplimiento."
          : "El perfil no tiene documentos de evidencia asociados."
        : "No hay un perfil de empresa asociado para contrastar estos requisitos.",
    },
    cautions: [
      "La lista conserva la clasificación guardada por el análisis automático; no es una certificación ni una decisión de cumplimiento.",
      "Revise en las fuentes si cada condición aplica a la participación, a la oferta o a la ejecución contractual.",
      ...(requirements.some((item) => item.deadline)
        ? [
            "Hay fechas guardadas en los requisitos; confirme sus efectos y vigencia en la fuente oficial.",
          ]
        : []),
      ...(!requirements.length
        ? [
            "El análisis guardado no contiene requisitos extraídos; esto no demuestra que no existan en las fuentes.",
          ]
        : []),
      ...(evidenceGaps.length
        ? [
            "Hay fuentes pendientes, incompletas o marcadas para revisión; la cobertura puede ser parcial.",
          ]
        : []),
      ...(!inventoryComplete
        ? [
            "La captura del inventario oficial no consta como completa; pueden faltar fuentes.",
          ]
        : []),
    ],
  };
  const rendered = renderExhaustiveChecklist(checklist);
  // The turn carries markdown in both `answer` and `answerMarkdown`.
  if (
    JSON.stringify(checklist).length + rendered.length * 2 >
    MAX_CHECKLIST_CHARS
  )
    fail("CHECKLIST_OUTPUT_LIMIT", 413);
  return checklist;
}

const categoryLabels: Record<Requirement["category"], string> = {
  scope: "Alcance",
  eligibility: "Habilitación",
  experience: "Experiencia",
  financial: "Capacidad financiera",
  guarantees: "Garantías",
  documents: "Documentos",
  deliverables: "Entregables",
  dates: "Fechas",
  evaluation: "Evaluación",
  other: "Otros",
};

export function renderExhaustiveChecklist(
  checklist: ExhaustiveChecklist,
  options: { includeSourceExcerpts?: boolean } = {},
) {
  const includeSourceExcerpts = options.includeSourceExcerpts ?? true;
  const groups = new Map<string, typeof checklist.items>();
  for (const item of checklist.items) {
    const label = categoryLabels[item.category];
    const group = groups.get(label) ?? [];
    group.push(item);
    groups.set(label, group);
  }
  const lines = [
    `## Lista de requisitos guardados (${checklist.coverage.requirements})`,
    "",
    "## Cobertura y revisión",
    `Inventario oficial completo: ${checklist.coverage.inventoryComplete ? "sí" : "no consta"} · Fuentes listadas: ${checklist.coverage.listedDocuments} · Para revisión: ${checklist.coverage.reviewRequiredDocuments} · No disponibles: ${checklist.coverage.unavailableDocuments}`,
    checklist.companyEvidence.note,
    ...checklist.companyEvidence.documents.map(
      (document) =>
        `- Evidencia de empresa: ${document.documentName} (${document.state}${document.expired ? ", vencido" : ""})`,
    ),
    ...checklist.evidenceGaps.map(
      (gap) =>
        `- Fuente pendiente o para revisión: ${gap.documentName} (${gap.state})${gap.error ? `; error: ${gap.error}` : ""}${gap.warnings.length ? `; advertencias: ${gap.warnings.join(", ")}` : ""}`,
    ),
    ...checklist.cautions.map((caution) => `- ${caution}`),
    "",
    ...[...groups.entries()].flatMap(([label, items]) => [
      `### ${label} (${items.length})`,
      ...items.map((item) => {
        const fields = [
          item.mandatory
            ? "Obligatorio según la extracción"
            : "No marcado obligatorio en la extracción",
          ...(item.lot ? [`Lote: ${item.lot}`] : []),
          ...(item.deadline
            ? [
                `Fecha/plazo extraído: ${item.deadline}${item.deadlineStatus === "past" ? " (fecha transcurrida; verifique la vigencia en la fuente)" : ""}`,
              ]
            : []),
          ...(item.rule
            ? [
                `Regla extraída: ${item.rule.field} ${item.rule.operator} ${item.rule.value} ${item.rule.unit}${item.rule.period ? ` (${item.rule.period})` : ""}`,
              ]
            : []),
          ...item.citations.map(
            (citation) =>
              `${citation.sourceRef} · ${citation.documentName}${citation.page ? ` (p. ${citation.page})` : ""}${citation.section ? ` · ${citation.section}` : ""}`,
          ),
        ];
        return `- **${item.reference}** ${item.wording} (${fields.join("; ")})`;
      }),
      "",
    ]),
    ...(includeSourceExcerpts
      ? [
          `### Fragmentos de las fuentes (${checklist.sources.length})`,
          ...checklist.sources.map((source) => {
            const location = [
              source.page ? `p. ${source.page}` : "",
              source.section ?? "",
            ]
              .filter(Boolean)
              .join(", ");
            return `${source.reference}: ${source.documentName}${location ? ` (${location})` : ""} — “${source.excerpt}”`;
          }),
        ]
      : []),
  ];
  return lines.join("\n");
}
