import { zipSync } from "fflate";
import { DossierError } from "./contracts";
import { sha256 } from "./downloads";
import { companyEvidence, type CompanyProfile } from "./companies";
import {
  buildExhaustiveChecklist,
  type ExhaustiveChecklist,
} from "./checklist";
import { dossierEvidence } from "./synthesis";
import { DossierRepository, type DossierEnv } from "./repository";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_SOURCE_CHARS = 750_000;
const MAX_PARAGRAPHS = 12_000;
const MAX_DOCX_BYTES = 12_000_000;
const MAX_TICKET_AGE = 10 * 60_000;
const invalidTicket = () => new DossierError("PROPOSAL_TICKET_INVALID", 404);

type ProposalTicket = {
  hash: string;
  expiresAt: number;
  fileId: string;
  dossierId: string;
  corpusRevision: number;
  reportId: string;
  companyProfileId: string | null;
  companyRevision: number | null;
};

type ParagraphStyle =
  | "Title"
  | "Heading1"
  | "Heading2"
  | "Requirement"
  | "SourceTitle"
  | "SourceText";

type Paragraph = { text: string; style?: ParagraphStyle };

const boldLabels = new Set([
  "Actividades declaradas en el perfil",
  "Advertencias",
  "Datos incluidos en el perfil; confirme cada dato con un soporte vigente",
  "Desglose editable",
  "Entidad",
  "Equipo de trabajo y dedicación",
  "Evidencia empresarial",
  "Evidencia empresarial asociada",
  "Forma y plazo de pago, vigencia de la oferta e impuestos",
  "Fuentes",
  "Generado",
  "Identificación legal",
  "Indicadores financieros y organizacionales",
  "Método, equipo y entregable ofrecido",
  "Objeto publicado",
  "Plan de trabajo y cronograma",
  "Presupuesto oficial publicado",
  "Proceso",
  "Razón social",
  "Referencia",
  "Referencia de fuente",
  "Regla",
  "Requisito del proceso",
  "Respuesta del proponente",
  "Resumen de la solución propuesta",
  "Soporte verificable",
  "Valor total de la oferta",
]);

function xml(value: string) {
  const valid = Array.from(value)
    .filter((char) => {
      const cp = char.codePointAt(0)!;
      return (
        cp === 0x9 ||
        cp === 0xa ||
        cp === 0xd ||
        (cp >= 0x20 && cp <= 0xd7ff) ||
        (cp >= 0xe000 && cp <= 0xfffd) ||
        (cp >= 0x10000 && cp <= 0x10ffff)
      );
    })
    .join("");
  return valid.replace(
    /[&<>"']/gu,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );
}

function documentXml(paragraphs: Paragraph[]) {
  const body = paragraphs
    .map(({ text, style }) => {
      const level =
        style === "Heading1" ? 0 : style === "Heading2" ? 1 : undefined;
      const styleXml = style
        ? `<w:pPr><w:pStyle w:val="${style}"/>${level === undefined ? "" : `<w:outlineLvl w:val="${level}"/>`}</w:pPr>`
        : "<w:pPr/>";
      const label = text.match(/^(.+?): /u);
      const hasBoldLabel = label && boldLabels.has(label[1]);
      const runs = hasBoldLabel
        ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xml(label[1])}: </w:t></w:r><w:r><w:t xml:space="preserve">${xml(text.slice(label[0].length))}</w:t></w:r>`
        : `<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
      return `<w:p>${styleXml}${runs}</w:p>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`;
}

function makeDocx(paragraphs: Paragraph[]) {
  if (paragraphs.length > MAX_PARAGRAPHS)
    throw new DossierError("PROPOSAL_TOO_LARGE", 413);
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="84" w:line="276" w:lineRule="auto"/><w:widowControl/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="000000"/><w:sz w:val="21"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="180"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="320" w:after="100"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="220" w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Requirement"><w:name w:val="Requirement"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="40"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="21"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="SourceTitle"><w:name w:val="Source title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="140" w:after="40"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="SourceText"><w:name w:val="Source text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="100" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="000000"/><w:sz w:val="20"/></w:rPr></w:style></w:styles>`,
    "word/document.xml": documentXml(paragraphs),
  };
  const bytes = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, value]) => [
        path,
        new TextEncoder().encode(value),
      ]),
    ),
    { level: 6 },
  );
  if (bytes.byteLength > MAX_DOCX_BYTES)
    throw new DossierError("PROPOSAL_TOO_LARGE", 413);
  return bytes;
}

function asText(value: unknown) {
  return value === undefined || value === null || value === ""
    ? "[COMPLETAR]"
    : String(value);
}

function sourceLabel(source: ExhaustiveChecklist["sources"][number]) {
  return `${source.documentName}${source.page ? ` · pág. ${source.page}` : source.section ? ` · ${source.section}` : ""}`;
}

function descriptionField(
  description: Record<string, unknown>,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = description[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return "";
}

function ruleDescription(rule: ExhaustiveChecklist["items"][number]["rule"]) {
  if (!rule) return "No se registró una regla cuantitativa.";
  const operators = { gte: "al menos", lte: "como máximo", eq: "igual a" };
  return `${rule.field}: ${operators[rule.operator]} ${rule.value} ${rule.unit}${rule.period ? `, período ${rule.period}` : ""}.`;
}

function compactSourceText(text: string) {
  return text.replace(/[\t ]*\r?\n[\t ]*/gu, " ").replace(/ {2,}/gu, " ").trim();
}

const categoryNames: Record<
  ExhaustiveChecklist["items"][number]["category"],
  string
> = {
  scope: "Alcance técnico",
  eligibility: "Habilitación",
  experience: "Experiencia",
  financial: "Condición financiera",
  guarantees: "Garantías",
  documents: "Documentos",
  deliverables: "Entregables",
  dates: "Fechas",
  evaluation: "Evaluación",
  other: "Otro requisito",
};

function composeProposal(input: {
  dossierId: string;
  description: Record<string, unknown>;
  checklist: ExhaustiveChecklist;
  company: CompanyProfile | null;
  companyEvidence: Awaited<ReturnType<typeof companyEvidence>> | null;
  conflicts: string[];
  descriptionSources?: Array<{
    reference: string;
    documentName: string;
    text: string;
    page?: number;
    section?: string;
  }>;
  generatedAt: string;
  corpusRevision: number;
}) {
  const {
    dossierId,
    description,
    checklist,
    company,
    companyEvidence: evidence,
    conflicts,
    descriptionSources = [],
  } = input;
  const companyFacts = company?.facts ?? [];
  const companyDocs = evidence?.docs ?? [];
  const companyChunks = evidence?.chunks ?? [];
  const companyExpired = evidence?.expired ?? new Set<string>();
  const entity = descriptionField(
    description,
    "entidad",
    "nombre_de_la_entidad",
    "nombre_entidad",
  );
  const object = descriptionField(
    description,
    "descripci_n_del_procedimiento",
    "descripcion_del_procedimiento",
    "nombre_del_procedimiento",
    "objeto",
  );
  const procedureName = descriptionField(
    description,
    "nombre_del_procedimiento",
  );
  const processReference =
    descriptionField(
      description,
      "referencia_del_proceso",
      "referencia_proceso",
    ) || dossierId;
  const officialBudget = descriptionField(
    description,
    "precio_base",
    "budget",
    "presupuesto",
    "valor_estimado",
    "estimatedValue",
  );
  const currencyUnit = "COP";
  const p: Paragraph[] = [];
  const add = (text: string, style?: Paragraph["style"]) => {
    const lines = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const [index, line] of lines.entries()) {
      let paragraphStyle = style;
      if (!paragraphStyle && index === 0) {
        if (/^R\d{3} ·/u.test(line)) paragraphStyle = "Requirement";
        else if (/^[DS]\d{3} ·/u.test(line)) paragraphStyle = "SourceTitle";
      }
      p.push({
        text: line,
        ...(paragraphStyle ? { style: paragraphStyle } : {}),
      });
    }
  };
  const addSection = (title: string) => add(title, "Heading1");
  const totalChars = JSON.stringify({
    description,
    descriptionSources,
    checklist,
    company,
    evidence: companyChunks,
    conflicts,
  }).length;
  if (totalChars > MAX_SOURCE_CHARS)
    throw new DossierError("PROPOSAL_TOO_LARGE", 413);

  add("Borrador editable de propuesta", "Title");
  add(
    `Generado: ${input.generatedAt} · revisión del expediente: ${input.corpusRevision}`,
  );
  add(
    `Proceso: ${processReference}${procedureName ? ` · ${procedureName}` : ""}`,
  );
  add(
    "Borrador de trabajo editable. Complete los campos marcados y verifique el expediente oficial antes de aprobar cualquier declaración o presentar una oferta.",
  );
  addSection("Carta de presentación");
  add(
    `Señores\n${asText(entity)}\n\nAsunto: Propuesta para ${processReference}${procedureName ? ` — ${procedureName}` : ""}\n\nYo, [COMPLETAR: representante legal autorizado], en nombre de ${asText(company?.name)}, identificado(a) con [COMPLETAR: identificación del representante], presento para revisión esta propuesta para el proceso de referencia.\n\nConfirmamos que el contenido y los soportes deben ser revisados por el proponente antes de firma o presentación. Esta plantilla no contiene declaraciones de cumplimiento ni manifestaciones de ausencia de inhabilidades o conflictos.\n\nAtentamente,\n\n[COMPLETAR: representante legal]\n[COMPLETAR: cargo, correo, teléfono y firma]`,
  );

  addSection("Identificación del proponente");
  add(`Razón social: ${asText(company?.name)}`);
  add(`Identificación legal: ${asText(company?.legalId)}`);
  add(`Actividades declaradas en el perfil: ${asText(company?.activities)}`);
  if (!company)
    add(
      "No se seleccionó un perfil de empresa. Complete todos los datos del proponente y agregue soportes antes de usar este borrador.",
    );
  add(
    "Los datos del perfil son información declarada por el usuario y no acreditan por sí solos habilitación o cumplimiento.",
  );
  add(
    "Datos incluidos en el perfil; confirme cada dato con un soporte vigente:",
  );
  if (!companyFacts.length)
    add(
      "[COMPLETAR: experiencia, capacidad, indicadores y datos del proponente con soportes verificables]",
    );
  for (const fact of companyFacts) {
    const cites = fact.citations.map((citation) => {
      const document = companyDocs.find(
        (d) => d.id === citation.documentVersionId,
      );
      const expired = companyExpired.has(citation.documentVersionId);
      return `${document?.value.name ?? "Evidencia de empresa"}${citation.page ? ` · pág. ${citation.page}` : citation.section ? ` · ${citation.section}` : ""}${expired ? " · VENCIDA" : ""}`;
    });
    add(
      `${fact.field}: ${fact.value} ${fact.unit}${fact.period ? ` (${fact.period})` : ""}. ${fact.reviewed ? "Marcado como revisado en el perfil; verifique contra el original." : "Sin revisión humana registrada."}${cites.length ? ` Soporte citado: ${cites.join("; ")}.` : " Sin cita de soporte."}`,
    );
  }
  add(
    `Evidencia empresarial asociada: ${companyDocs.length} documento(s), ${companyExpired.size} vencido(s). Revise vigencia, integridad y pertinencia de cada original.`,
  );

  addSection("Objeto y respuesta técnica");
  add(`Entidad: ${asText(entity)}`);
  add(`Referencia: ${processReference}`);
  const firstDescriptionSource = descriptionSources[0];
  add(
    `Objeto publicado: ${asText(object)}${firstDescriptionSource ? ` (descripción oficial, extracto ${firstDescriptionSource.reference}: ${firstDescriptionSource.documentName}${firstDescriptionSource.page ? ` · pág. ${firstDescriptionSource.page}` : ""})` : ""}`,
  );
  add(
    "Resumen de la solución propuesta: [COMPLETAR por el proponente con base en el objeto y los requisitos. No se atribuyen capacidades ni experiencia que no estén sustentadas].",
  );
  add(
    "Matriz de respuesta editable por requisito técnico, alcance o entregable:",
  );
  const technicalItems = checklist.items.filter((item) =>
    ["scope", "deliverables", "other"].includes(item.category),
  );
  if (!technicalItems.length)
    add(
      "[COMPLETAR: metodología, actividades y entregables tras revisar el pliego. El análisis actual no identificó requisitos en estas categorías; esto no acredita que no existan].",
    );
  for (const item of technicalItems) {
    const refs =
      item.citations.map((citation) => citation.sourceRef).join(", ") ||
      "sin cita";
    add(
      `${item.reference} · ${categoryNames[item.category]}\nRequisito del proceso: ${item.wording}\nRespuesta del proponente: [COMPLETAR]\nMétodo, equipo y entregable ofrecido: [COMPLETAR]\nSoporte verificable: [COMPLETAR]\nReferencia de fuente: ${refs}`,
    );
  }
  add(
    "Plan de trabajo y cronograma: [COMPLETAR actividades, hitos y responsables compatibles con las fechas oficiales].",
  );
  add(
    "Equipo de trabajo y dedicación: [COMPLETAR perfiles, experiencia acreditada y disponibilidad].",
  );

  addSection("Oferta económica");
  const budgetWithCurrency =
    officialBudget && /\bCOP\b/iu.test(officialBudget)
      ? officialBudget
      : officialBudget
        ? `${officialBudget} ${currencyUnit}`
        : "";
  add(
    `Presupuesto oficial publicado: ${budgetWithCurrency || "[No identificado en los campos conocidos; confirme en la fuente oficial]"}. Este valor es informativo y no es la oferta del proponente.`,
  );
  add(
    "Valor total de la oferta: [COMPLETAR por el proponente; no se genera una cifra automáticamente].",
  );
  add(
    "Desglose editable: personal [COMPLETAR]; materiales/equipos [COMPLETAR]; transporte/logística [COMPLETAR]; administración [COMPLETAR]; impuestos [COMPLETAR]; otros costos [COMPLETAR]; total [COMPLETAR].",
  );
  add(
    "Forma y plazo de pago, vigencia de la oferta e impuestos: [COMPLETAR según pliego y aprobación del proponente].",
  );

  addSection("Experiencia y capacidad del proponente");
  for (const index of [1, 2, 3])
    add(
      `Experiencia ${index}: entidad contratante [COMPLETAR]; objeto y alcance [COMPLETAR]; fechas [COMPLETAR]; cuantía [COMPLETAR]; porcentaje de participación [COMPLETAR]; certificación y contacto verificable [COMPLETAR].`,
    );
  add(
    "El expediente de la licitación no acredita la experiencia del proponente.",
  );
  add(
    "Indicadores financieros y organizacionales: [COMPLETAR con cifras del período exigido y sus soportes]. No se calculan ni infieren cifras desde el presupuesto oficial.",
  );

  addSection("Condiciones y requisitos del proceso");
  add(
    `Requisitos incluidos: ${checklist.items.length}. Citas de requisitos: ${checklist.coverage.citedRequirements}. Fuentes listadas: ${checklist.coverage.listedDocuments}. Inventario oficial completo: ${checklist.coverage.inventoryComplete ? "sí según el registro" : "no"}.`,
  );
  add(
    "La clasificación automática conserva el resultado guardado y no certifica cumplimiento. Cada requisito debe revisarse en su fuente original.",
  );
  for (const item of checklist.items) {
    const refs =
      item.citations.map((citation) => citation.sourceRef).join(", ") ||
      "sin cita";
    const dateStatus = item.deadline
      ? ` Fecha extraída: ${item.deadline}${item.deadlineStatus === "past" ? " — POSIBLEMENTE VENCIDA; confirme en fuente oficial" : item.deadlineStatus === "upcoming" ? " — confirmar vigencia y zona horaria" : " — vigencia no determinada; confirme en fuente oficial"}.`
      : "";
    add(
      `${item.reference} · ${categoryNames[item.category]} · ${item.mandatory ? "marcado obligatorio" : "no marcado obligatorio"}${item.lot ? ` · Lote ${item.lot}` : ""}\n${item.wording}\nRegla: ${ruleDescription(item.rule)} ${dateStatus}\nFuentes: ${refs}.`,
    );
  }

  addSection("Documentos y estado de cobertura");
  if (!checklist.evidenceGaps.length)
    add(
      "No hay documentos del expediente marcados con brechas en el reporte actual. Esto no confirma que la extracción sea exacta ni que la cobertura material sea suficiente.",
    );
  for (const gap of checklist.evidenceGaps)
    add(
      `${gap.documentName} · estado: ${gap.state}${gap.error ? ` · error: ${gap.error}` : ""}${gap.warnings.length ? `\nAdvertencias: ${gap.warnings.join("; ")}` : ""}`,
    );
  for (const doc of companyDocs)
    add(
      `Evidencia empresarial: ${String(doc.value.name ?? "Documento sin nombre")} · estado: ${String(doc.value.state ?? "desconocido")}${companyExpired.has(doc.id) ? " · VENCIDA" : ""}${doc.value.expiresOn ? ` · vence: ${String(doc.value.expiresOn)}` : ""}. Revise el original antes de citar o declarar su validez.`,
    );
  for (const caution of checklist.cautions) add(`Advertencia: ${caution}`);
  if (checklist.coverage.reviewRequiredDocuments)
    add(
      `REVISIÓN OCR: ${checklist.coverage.reviewRequiredDocuments} extracción(es) requieren cotejo con los documentos originales. No trate el texto extraído como exacto.`,
    );
  if (checklist.items.some((item) => item.deadlineStatus === "past"))
    add(
      "Hay fechas de requisitos que el sistema estima pasadas. Confirme en SECOP la fecha, hora, zona horaria, prórrogas y vigencia; no se concluye que el proceso esté cerrado.",
    );

  addSection("Garantías, declaraciones y salvedades");
  add(
    "Garantías exigidas, amparos, porcentajes, vigencias y tomador: [COMPLETAR desde las fuentes oficiales y validar con aseguradora]. No se ha asumido ni ofrecido garantía alguna.",
  );
  add(
    "Declaraciones, inhabilidades, conflictos de interés, integridad y autorización para contratar: [COMPLETAR tras revisión jurídica y aprobación del representante autorizado]. Este documento no certifica que la empresa cumpla condiciones ni que no existan conflictos.",
  );
  add(
    "El análisis automático puede conservar requisitos contradictorios. Resuelva cualquier diferencia leyendo las fuentes originales y las adendas vigentes.",
  );
  if (conflicts.length) {
    add(
      "Alertas de posible contradicción registradas por el análisis; no se determina cuál texto prevalece:",
    );
    for (const conflict of conflicts)
      add(`Revisar en las fuentes oficiales: ${conflict}`);
  }

  addSection("Anexo A — Extractos de fuentes del expediente");
  for (const source of descriptionSources) {
    add(
      `${source.reference} · ${source.documentName}${source.page ? ` · pág. ${source.page}` : source.section ? ` · ${source.section}` : ""}`,
      "SourceTitle",
    );
    add(compactSourceText(source.text), "SourceText");
  }
  for (const source of checklist.sources) {
    add(`${source.reference} · ${sourceLabel(source)}`, "SourceTitle");
    add(compactSourceText(source.excerpt), "SourceText");
  }
  addSection("Anexo B — Extractos de evidencia de la empresa");
  if (!companyChunks.length)
    add(
      "No hay extractos de evidencia de empresa asociados al perfil seleccionado. Adjunte y revise los soportes antes de afirmar experiencia o capacidad.",
    );
  for (const chunk of companyChunks) {
    const doc = companyDocs.find((item) => item.id === chunk.documentVersionId);
    add(
      `${String(doc?.value.name ?? "Documento de empresa sin nombre")}${chunk.page ? ` · pág. ${chunk.page}` : chunk.section ? ` · ${chunk.section}` : ""}${companyExpired.has(chunk.documentVersionId) ? " · VENCIDA" : ""}${doc?.value.state === "review_required" ? " · EXTRACCIÓN POR REVISAR" : ""}`,
      "SourceTitle",
    );
    add(compactSourceText(chunk.text), "SourceText");
  }
  addSection("Anexo C — Lista editable de documentos por preparar");
  const attachmentItems = checklist.items.filter((item) =>
    [
      "eligibility",
      "experience",
      "financial",
      "guarantees",
      "documents",
    ].includes(item.category),
  );
  if (!attachmentItems.length)
    add(
      "[ ] Revisar el pliego y completar la lista de anexos; el análisis no identificó requisitos documentales por categoría.",
    );
  for (const item of attachmentItems)
    add(
      `[ ] ${item.reference}: ${item.wording} — soporte a adjuntar: [COMPLETAR]`,
    );
  add(
    "[ ] Confirmar que el proceso y sus adendas siguen vigentes.\n[ ] Cotejar las extracciones señaladas para revisión OCR.\n[ ] Adjuntar certificados empresariales actuales y verificar vencimientos.\n[ ] Completar precio, representante, contacto y declaraciones autorizadas.\n[ ] Revisar contradicciones, garantías y documentos habilitantes.\n[ ] Validar el archivo final y su presentación en el canal oficial.",
  );
  add(
    "Este DOCX es un borrador editable y no ha sido presentado ni enviado a SECOP.",
  );
  return p;
}

async function assertCurrent(
  repo: DossierRepository,
  context: {
    dossierId: string;
    corpusRevision: number;
    reportId: string;
    companyProfileId: string | null;
    companyRevision: number | null;
  },
) {
  const dossier = await repo.readDossier(context.dossierId);
  if (
    dossier.value.corpusRevision !== context.corpusRevision ||
    dossier.value.reportId !== context.reportId ||
    dossier.value.needsSynthesis === true
  )
    throw new DossierError("PROPOSAL_CONTEXT_CHANGED", 409, true);
  if (context.companyProfileId) {
    const company = await repo.read<CompanyProfile>(
      "company",
      context.companyProfileId,
    );
    if (company.revision !== context.companyRevision)
      throw new DossierError("PROPOSAL_CONTEXT_CHANGED", 409, true);
  } else if (context.companyRevision !== null) {
    throw new DossierError("PROPOSAL_CONTEXT_CHANGED", 409, true);
  }
}

export async function createProposalDocument(
  repo: DossierRepository,
  input: { dossierId: string; companyProfileId?: string },
  origin: string,
) {
  const dossier = await repo.readDossier(input.dossierId);
  const revision =
    typeof dossier.value.corpusRevision === "number"
      ? dossier.value.corpusRevision
      : -1;
  const reportId =
    typeof dossier.value.reportId === "string" ? dossier.value.reportId : "";
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    reportId !== `${input.dossierId}:${revision}` ||
    dossier.value.needsSynthesis === true ||
    (dossier.value.coverage as { inventoryComplete?: unknown } | undefined)
      ?.inventoryComplete !== true
  )
    throw new DossierError("PROPOSAL_REPORT_NOT_READY", 409);
  const report = (await repo.read<Record<string, unknown>>("report", reportId))
    .value;
  if (
    report.dossierId !== input.dossierId ||
    report.corpusRevision !== revision
  )
    throw new DossierError("PROPOSAL_REPORT_NOT_READY", 409);
  const { chunks } = await dossierEvidence(repo, input.dossierId);
  const descriptionDocumentId =
    typeof dossier.value.descriptionId === "string"
      ? dossier.value.descriptionId
      : undefined;
  const descriptionSources = descriptionDocumentId
    ? chunks
        .filter((chunk) => chunk.documentVersionId === descriptionDocumentId)
        .sort((a, b) => a.index - b.index)
        .map((chunk, index) => ({
          reference: `D${String(index + 1).padStart(3, "0")}`,
          documentName: "Descripción oficial del proceso",
          text: chunk.text,
          ...(chunk.page ? { page: chunk.page } : {}),
          ...(chunk.section ? { section: chunk.section } : {}),
        }))
    : [];
  const company = input.companyProfileId
    ? await companyEvidence(repo, input.companyProfileId)
    : null;
  const checklist = await buildExhaustiveChecklist(
    repo,
    input.dossierId,
    revision,
    reportId,
    report,
    chunks,
    company,
  );
  const paragraphs = composeProposal({
    dossierId: input.dossierId,
    description: (dossier.value.description ?? {}) as Record<string, unknown>,
    checklist,
    company: company?.company.value ?? null,
    companyEvidence: company,
    descriptionSources,
    generatedAt: new Date(repo.now()).toISOString(),
    corpusRevision: revision,
    conflicts: Array.isArray(report.conflicts)
      ? report.conflicts.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  });
  const bytes = makeDocx(paragraphs);
  const current = {
    dossierId: input.dossierId,
    corpusRevision: revision,
    reportId,
    companyProfileId: input.companyProfileId ?? null,
    companyRevision: company?.company.revision ?? null,
  };
  await assertCurrent(repo, current);
  const id = crypto.randomUUID();
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const expiresAt = repo.now() + MAX_TICKET_AGE;
  await repo.putFile(fileId, bytes, DOCX_MIME);
  try {
    await repo.save<ProposalTicket>(
      "proposal",
      id,
      {
        hash: await sha256(secret),
        expiresAt,
        fileId,
        dossierId: input.dossierId,
        corpusRevision: revision,
        reportId,
        companyProfileId: input.companyProfileId ?? null,
        companyRevision: company?.company.revision ?? null,
      },
      0,
    );
    await assertCurrent(repo, current);
  } catch (error) {
    await repo.deleteFile(fileId);
    throw error;
  }
  return {
    revision: 0,
    messages: [],
    document: {
      url: `${origin}/private/proposal/${encodeURIComponent(`${repo.context.ownerId}.${id}.${secret}`)}`,
      fileName: "borrador-propuesta.docx",
      format: "docx",
    },
  };
}

export async function readProposalTicket(
  env: DossierEnv,
  token: string,
  now = Date.now(),
) {
  const [ownerId, id, secret, ...extra] = token.split(".");
  if (
    extra.length ||
    !ownerId ||
    !id ||
    !secret ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(ownerId)
  )
    throw invalidTicket();
  const repo = new DossierRepository(
    env,
    { ownerId, scopes: ["dossier:read"] },
    () => now,
  );
  let stored;
  try {
    stored = await repo.read<ProposalTicket>("proposal", id);
  } catch {
    throw invalidTicket();
  }
  const ticket = stored.value;
  if (ticket.expiresAt <= now || ticket.hash !== (await sha256(secret)))
    throw invalidTicket();
  try {
    const dossier = await repo.readDossier(ticket.dossierId);
    if (
      dossier.value.corpusRevision !== ticket.corpusRevision ||
      dossier.value.reportId !== ticket.reportId ||
      dossier.value.needsSynthesis === true
    )
      throw invalidTicket();
    if (ticket.companyProfileId) {
      const company = await repo.read<CompanyProfile>(
        "company",
        ticket.companyProfileId,
      );
      if (company.revision !== ticket.companyRevision) throw invalidTicket();
    } else if (ticket.companyRevision !== null) throw invalidTicket();
    const report = await repo.read<Record<string, unknown>>(
      "report",
      ticket.reportId,
    );
    if (
      report.value.dossierId !== ticket.dossierId ||
      report.value.corpusRevision !== ticket.corpusRevision
    )
      throw invalidTicket();
    const file = await repo.getFile(ticket.fileId);
    if (
      !file ||
      file.httpMetadata?.contentType !== DOCX_MIME ||
      file.size > MAX_DOCX_BYTES
    )
      throw invalidTicket();
    return new Response(file.body, {
      status: 200,
      headers: {
        // Fetch this short-lived bearer URL without cookies before saving a
        // private copy through Savia's authenticated Office API.
        "Access-Control-Allow-Origin": "*",
        "Content-Type": DOCX_MIME,
        "Content-Disposition": 'attachment; filename="borrador-propuesta.docx"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    throw invalidTicket();
  }
}
