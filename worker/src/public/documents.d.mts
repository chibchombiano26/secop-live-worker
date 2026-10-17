export interface SecopDocumentsTender {
  id_del_proceso: string;
  id_del_portafolio: string;
  referencia_del_proceso: string | null;
  entidad: string | null;
  nit_entidad: string | null;
}

export interface SecopTenderDocument {
  id_del_proceso: string;
  id_documento: string | null;
  proceso: string;
  nombre_archivo: string | null;
  tamanno_archivo: string | null;
  extensi_n: string | null;
  descripci_n: string | null;
  fecha_carga: string | null;
  entidad: string | null;
  nit_entidad: string | null;
  url_descarga_documento: string | null;
}

export interface SecopDocumentsResult {
  data: SecopTenderDocument[];
  tender: SecopDocumentsTender | null;
  association: {
    status: "verified" | "unresolved";
    method: "exact_id_del_portafolio_equals_document_proceso";
    id_del_proceso: string;
    id_del_portafolio: string | null;
    field: "proceso";
    reason?: string;
  };
  pagination: { limit: number; offset: number; has_more: boolean };
}

export interface SecopDocumentsDependencies {
  env: Record<string, unknown>;
  socrataFetch(
    dataset: string,
    soql: string,
    env: Record<string, unknown>,
  ): Promise<unknown>;
  tenderDataset: string;
  documentsDataset: string;
  stringSchema(): unknown;
  numberSchema(): {
    int(): SecopNumberSchema;
  };
}

export interface SecopNumberSchema {
  min(value: number): SecopNumberSchema;
  max(value: number): SecopNumberSchema;
  optional(): unknown;
}

export interface SecopDocumentsToolServer {
  registerTool(
    name: string,
    config: {
      description: string;
      inputSchema: {
        id_del_proceso: unknown;
        limit: unknown;
        offset: unknown;
      };
      annotations: {
        readOnlyHint: true;
        destructiveHint: false;
        openWorldHint: true;
      };
    },
    handler: (input: {
      id_del_proceso: string;
      limit?: number;
      offset?: number;
    }) => Promise<unknown>,
  ): unknown;
}

export function readSecopDocuments(
  input: { id_del_proceso: string; limit?: number; offset?: number },
  deps: SecopDocumentsDependencies,
): Promise<SecopDocumentsResult>;

export function registerSecopDocumentsTool(
  server: SecopDocumentsToolServer,
  deps: SecopDocumentsDependencies,
): void;
