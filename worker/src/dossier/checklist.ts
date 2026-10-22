import { DossierError } from "./contracts";
import type { DossierRepository } from "./repository";
import { readManyBatched } from "./read-many";
import type { EvidenceChunk } from "./extraction";
import type { Requirement } from "./synthesis";
import { requirementSchema, validateCitations } from "./synthesis";

// Complete multi-document checklists are persisted as bounded private R2 turns.
const MAX_CHECKLIST_CHARS = 20_000_000;

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

const spanishMonths: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

/** Return whether the extracted deadline has passed, using Bogota day-end for Spanish dates. */
export function checklistDeadlineStatus(
  value: string | null,
  now: number,
): "past" | "upcoming" | null {
  if (!value) return null;
  const spanishDate = value.match(
    /^\s*(\d{1,2})\s+de\s+([\p{L}]+)\s+de\s+(\d{4})(?:[\s,]+(?:a\s+las\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/iu,
  );
  if (spanishDate) {
    const day = Number(spanishDate[1]);
    const month = spanishMonths[spanishDate[2].toLowerCase()];
    const year = Number(spanishDate[3]);
    if (!month || year < 1) return null;
    if (
      spanishDate[4] !== undefined &&
      (Number(spanishDate[4]) > 23 ||
        Number(spanishDate[5]) > 59 ||
        Number(spanishDate[6] ?? 0) > 59)
    )
      return null;
    const start = new Date(Date.UTC(year, month - 1, day));
    if (
      start.getUTCFullYear() !== year ||
      start.getUTCMonth() !== month - 1 ||
      start.getUTCDate() !== day
    )
      return null;
    // Bogotá is UTC-5. This is 23:59:59.999 local on the stated day.
    const endOfDayBogota = Date.UTC(year, month - 1, day + 1, 4, 59, 59, 999);
    return endOfDayBogota < now ? "past" : "upcoming";
  }
  if (/\bde\b/iu.test(value)) return null;

  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    )
      return null;
    const endOfDayUtc = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
    return endOfDayUtc < now ? "past" : "upcoming";
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? timestamp < now
      ? "past"
      : "upcoming"
    : null;
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

  const requirementIds: string[] = [];
  const seenRequirementIds = new Set<string>();
  for (const id of report.requirementIds as unknown[]) {
    if (typeof id !== "string" || !id || seenRequirementIds.has(id))
      fail("CHECKLIST_INVALID_REPORT");
    seenRequirementIds.add(id);
    requirementIds.push(id);
  }
  const requirements: ExhaustiveChecklist["items"] = [];
  const sourceByKey = new Map<string, ExhaustiveChecklist["sources"][number]>();
  const docs = new Map<
    string,
    { name: string; state: string; warnings: string[]; error?: string }
  >();
  const dossier = await repo.readDossier(dossierId);
  const listedDocumentIds = (dossier.value.documentIds ?? []) as unknown[];
  if (
    !Array.isArray(listedDocumentIds) ||
    listedDocumentIds.some((id) => typeof id !== "string" || !id)
  )
    fail("CHECKLIST_STALE_SOURCE");
  const descriptionId =
    typeof dossier.value.descriptionId === "string" &&
    dossier.value.descriptionId
      ? dossier.value.descriptionId
      : undefined;
  const documentIds = [
    ...new Set([
      ...(listedDocumentIds as string[]),
      ...(descriptionId ? [descriptionId] : []),
    ]),
  ];
  const storedDocuments = await readManyBatched<Record<string, unknown>>(
    repo,
    "document",
    documentIds,
    { allowMissing: true },
  );
  const documentsById = new Map(
    storedDocuments.map((document) => [document.id, document]),
  );
  for (const id of listedDocumentIds as string[]) {
    const doc = documentsById.get(id);
    if (!doc) fail("CHECKLIST_STALE_SOURCE");
    docs.set(id, {
      name:
        typeof doc.value.name === "string"
          ? doc.value.name
          : "Documento sin nombre",
      state: typeof doc.value.state === "string" ? doc.value.state : "unknown",
      warnings: Array.isArray(doc.value.warnings)
        ? doc.value.warnings.filter((x): x is string => typeof x === "string")
        : [],
      ...(typeof doc.value.error === "string"
        ? { error: doc.value.error }
        : {}),
    });
  }
  if (descriptionId) {
    const doc = documentsById.get(descriptionId);
    if (doc)
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
  }

  let storedRequirements;
  try {
    storedRequirements = await readManyBatched<Record<string, unknown>>(
      repo,
      "requirement",
      requirementIds,
    );
  } catch (error) {
    if (error instanceof DossierError && error.code === "NOT_FOUND")
      fail("CHECKLIST_STALE_REQUIREMENT");
    throw error;
  }
  for (const [index, stored] of storedRequirements.entries()) {
    const rawId = requirementIds[index];
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
      deadlineStatus: checklistDeadlineStatus(requirement.deadline, repo.now()),
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
  financial: "Valores y condiciones financieras",
  guarantees: "Garantías",
  documents: "Documentos",
  deliverables: "Entregables",
  dates: "Fechas",
  evaluation: "Evaluación",
  other: "Otros",
};

function sourceStateLabel(state: string) {
  return (
    (
      {
        ready: "procesado",
        review_required: "extracción por revisar",
        pending: "pendiente de extracción",
        failed: "no se pudo procesar",
        blocked: "requiere ayuda para acceder",
      } as Record<string, string>
    )[state] ?? "estado por verificar"
  );
}

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
  const pastSubmission = checklist.items.filter(
    (item) =>
      item.deadlineStatus === "past" &&
      /(?:presentacion|recepcion|radicacion|entrega|cierre|presentar|recibir|radicar|entregar)(?:\s+(?:de|del|la|el|las|los|para|sus|su|una|unas)){0,4}\s+(?:ofertas?|propuestas?)\b/iu.test(
        item.wording.normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
      ),
  );
  const lines = [
    ...(pastSubmission.length
      ? [
          "## Plazo de presentación transcurrido",
          "",
          ...pastSubmission.map(
            (item) =>
              `- ${item.wording}: ${item.deadline}. ${item.citations.map((c) => `[${c.sourceRef}] ${c.documentName}${c.page ? ` (p. ${c.page})` : ""}`).join("; ")}`,
          ),
          "",
          "No se debe asumir que este proceso recibe ofertas actualmente. Verifica su estado y las actuaciones posteriores en SECOP.",
          "",
        ]
      : []),
    `## Lista de requisitos guardados (${checklist.coverage.requirements})`,
    "",
    "## Cobertura y revisión",
    `Inventario oficial completo: ${checklist.coverage.inventoryComplete ? "sí" : "no consta"} · Fuentes listadas: ${checklist.coverage.listedDocuments} · Para revisión: ${checklist.coverage.reviewRequiredDocuments} · No disponibles: ${checklist.coverage.unavailableDocuments}`,
    checklist.companyEvidence.note,
    ...checklist.companyEvidence.documents.map(
      (document) =>
        `- Evidencia de empresa: ${document.documentName} (${sourceStateLabel(document.state)}${document.expired ? ", vencido" : ""})`,
    ),
    ...checklist.evidenceGaps.map(
      (gap) =>
        `- Fuente pendiente o para revisión: ${gap.documentName} (${sourceStateLabel(gap.state)})${gap.error ? "; consulta el documento para resolver el acceso o la extracción" : ""}${gap.warnings.length ? "; contrasta la extracción automática con el original" : ""}`,
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
            ? ["Regla numérica extraída pendiente de verificar"]
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
