const SECOP_PROCESS_ID = /^CO1\.[A-Z0-9_-]{2,12}\.[A-Z0-9._-]{1,80}$/;
const SECOP_DOCUMENTS_LIMIT_DEFAULT = 50;
const SECOP_DOCUMENTS_LIMIT_MAX = 100;
const SECOP_DOCUMENTS_OFFSET_MAX = 10000;
const SECOP_DOCUMENT_FIELDS = Object.freeze([
  "id_documento",
  "proceso",
  "nombre_archivo",
  "tamanno_archivo",
  "extensi_n",
  "descripci_n",
  "fecha_carga",
  "entidad",
  "nit_entidad",
  "url_descarga_documento",
]);
const SECOP_DOWNLOAD_HOST = "community.secop.gov.co";
const SECOP_DOWNLOAD_PATH = "/Public/Archive/RetrieveFile/Index";

function validateProcessId(value, fieldName) {
  if (typeof value !== "string" || !SECOP_PROCESS_ID.test(value)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return value;
}

function validatePage(input = {}) {
  const limit = input.limit ?? SECOP_DOCUMENTS_LIMIT_DEFAULT;
  const offset = input.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SECOP_DOCUMENTS_LIMIT_MAX
  ) {
    throw new Error("Invalid limit");
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > SECOP_DOCUMENTS_OFFSET_MAX
  ) {
    throw new Error("Invalid offset");
  }
  return { limit, offset };
}

function quoteSoqlString(value) {
  // Inputs are validated against SECOP_PROCESS_ID before reaching this helper.
  return `'${value}'`;
}

function parseTenderRows(rows, processId) {
  if (!Array.isArray(rows)) throw new Error("Tender lookup failed");
  if (rows.length === 0) return { tender: null, reason: "tender_not_found" };
  if (rows.length !== 1) {
    return { tender: null, reason: "tender_lookup_ambiguous" };
  }
  const tender = rows[0];
  if (!tender || typeof tender !== "object" || Array.isArray(tender)) {
    throw new Error("Tender lookup failed");
  }
  if (tender.id_del_proceso !== processId) {
    return { tender: null, reason: "tender_id_mismatch" };
  }
  let portfolioId;
  try {
    portfolioId = validateProcessId(
      tender.id_del_portafolio,
      "tender portfolio ID",
    );
  } catch {
    return {
      tender: {
        id_del_proceso: processId,
        id_del_portafolio: null,
        referencia_del_proceso: tender.referencia_del_proceso ?? null,
        entidad: tender.entidad ?? null,
        nit_entidad: tender.nit_entidad ?? null,
      },
      reason: "portfolio_id_missing_or_invalid",
    };
  }
  return {
    tender: {
      id_del_proceso: tender.id_del_proceso,
      id_del_portafolio: portfolioId,
      referencia_del_proceso: tender.referencia_del_proceso ?? null,
      entidad: tender.entidad ?? null,
      nit_entidad: tender.nit_entidad ?? null,
    },
    reason: null,
  };
}

function safeDownloadUrl(value, documentId) {
  const candidate = typeof value === "string" ? value : value?.url;
  if (typeof candidate !== "string") return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== SECOP_DOWNLOAD_HOST ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443") ||
      url.pathname !== SECOP_DOWNLOAD_PATH ||
      typeof documentId !== "string" ||
      url.searchParams.get("DocumentId") !== documentId
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseDocumentRows(rows, processId, portfolioId) {
  if (!Array.isArray(rows)) throw new Error("Document lookup failed");
  const documents = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Document lookup failed");
    }
    // Fail closed if Socrata ever returns a row outside the exact association
    // used in the WHERE clause. Do not substitute entity/name matching.
    if (row.proceso !== portfolioId) return null;
    documents.push({
      id_del_proceso: processId,
      id_documento: row.id_documento ?? null,
      proceso: row.proceso,
      nombre_archivo: row.nombre_archivo ?? null,
      tamanno_archivo: row.tamanno_archivo ?? null,
      extensi_n: row.extensi_n ?? null,
      descripci_n: row.descripci_n ?? null,
      fecha_carga: row.fecha_carga ?? null,
      entidad: row.entidad ?? null,
      nit_entidad: row.nit_entidad ?? null,
      url_descarga_documento: safeDownloadUrl(
        row.url_descarga_documento,
        typeof row.id_documento === "string" ? row.id_documento : null,
      ),
    });
  }
  return documents;
}

function unresolvedResult(processId, limit, offset, reason, tender = null) {
  return {
    data: [],
    tender,
    association: {
      status: "unresolved",
      method: "exact_id_del_portafolio_equals_document_proceso",
      id_del_proceso: processId,
      id_del_portafolio: tender?.id_del_portafolio ?? null,
      field: "proceso",
      reason,
    },
    pagination: { limit, offset, has_more: false },
  };
}

function tenderQuery(processId) {
  return [
    "SELECT id_del_proceso, id_del_portafolio, referencia_del_proceso, entidad, nit_entidad",
    `WHERE id_del_proceso = ${quoteSoqlString(processId)}`,
    "LIMIT 2",
  ].join(" ");
}

function documentsQuery(portfolioId, limit, offset) {
  return [
    `SELECT ${SECOP_DOCUMENT_FIELDS.join(", ")}`,
    `WHERE proceso = ${quoteSoqlString(portfolioId)}`,
    "ORDER BY fecha_carga DESC, id_documento DESC",
    `LIMIT ${limit + 1} OFFSET ${offset}`,
  ].join(" ");
}

/**
 * Resolve a tender by its platform process ID, then fetch documents only when
 * the document dataset's process value exactly equals that tender's portfolio
 * ID. In the public datasets this bridges CO1.REQ IDs to CO1.BDOS document IDs.
 */
export async function readSecopDocuments(input, deps) {
  const processId = validateProcessId(input?.id_del_proceso, "process ID");
  const { limit, offset } = validatePage(input);

  let tenderRows;
  try {
    tenderRows = await deps.socrataFetch(
      deps.tenderDataset,
      tenderQuery(processId),
      deps.env,
    );
  } catch {
    throw new Error("Tender lookup failed");
  }
  const parsedTender = parseTenderRows(tenderRows, processId);
  const tender = parsedTender.tender;
  if (!tender || parsedTender.reason) {
    return unresolvedResult(
      processId,
      limit,
      offset,
      parsedTender.reason ?? "portfolio_id_missing_or_invalid",
      tender,
    );
  }

  let documentRows;
  try {
    documentRows = await deps.socrataFetch(
      deps.documentsDataset,
      documentsQuery(tender.id_del_portafolio, limit, offset),
      deps.env,
    );
  } catch {
    throw new Error("Document lookup failed");
  }
  const hasMore = Array.isArray(documentRows) && documentRows.length > limit;
  const documents = parseDocumentRows(
    hasMore ? documentRows.slice(0, limit) : documentRows,
    tender.id_del_proceso,
    tender.id_del_portafolio,
  );
  if (!documents) {
    return unresolvedResult(
      processId,
      limit,
      offset,
      "document_process_id_mismatch",
      tender,
    );
  }
  return {
    data: documents,
    tender,
    association: {
      status: "verified",
      method: "exact_id_del_portafolio_equals_document_proceso",
      id_del_proceso: tender.id_del_proceso,
      id_del_portafolio: tender.id_del_portafolio,
      field: "proceso",
    },
    pagination: { limit, offset, has_more: hasMore },
  };
}

export function registerSecopDocumentsTool(server, deps) {
  server.registerTool(
    "documentos_licitacion",
    {
      description:
        "Lists public SECOP II documents linked to one tender by exact equality between the tender's ID del Portafolio and the document dataset's Proceso field. It does not use entity or keyword matching.",
      inputSchema: {
        id_del_proceso: deps.stringSchema(),
        limit: deps
          .numberSchema()
          .int()
          .min(1)
          .max(SECOP_DOCUMENTS_LIMIT_MAX)
          .optional(),
        offset: deps
          .numberSchema()
          .int()
          .min(0)
          .max(SECOP_DOCUMENTS_OFFSET_MAX)
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const data = await readSecopDocuments(input, deps);
      if (data.association.status !== "verified")
        throw new Error(
          "The tender document association could not be verified.",
        );
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );
}
