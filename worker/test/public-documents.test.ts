import { describe, expect, it, vi } from "vitest";
import type { SecopDocumentsDependencies } from "../src/public/documents.mjs";
import {
  readSecopDocuments,
  registerSecopDocumentsTool,
} from "../src/public/documents.mjs";

const TENDER_DATASET = "p6dx-8zbt";
const DOCUMENTS_DATASET = "dmgg-8hin";
const PROCESS_ID = "CO1.REQ.10391118";
const PORTFOLIO_ID = "CO1.BDOS.10216199";

const tender = {
  id_del_proceso: PROCESS_ID,
  id_del_portafolio: PORTFOLIO_ID,
  referencia_del_proceso: "CONTRATO 002 -2026",
  entidad: "COLEGIO ECOLOGICO DE FLORIDABLANCA",
  nit_entidad: "900118017",
};

function documentRow(id_documento: string, proceso = PORTFOLIO_ID) {
  return {
    id_documento,
    proceso,
    nombre_archivo: "CONTRATO 002 - PLATAFORMA ACADEMICA.pdf",
    tamanno_archivo: "233977",
    extensi_n: "pdf",
    descripci_n: "CONTRATO 002 - PLATAFORMA ACADEMICA.pdf",
    fecha_carga: "2026-05-07T00:00:00.000",
    entidad: tender.entidad,
    nit_entidad: tender.nit_entidad,
    url_descarga_documento: {
      url: `https://community.secop.gov.co/Public/Archive/RetrieveFile/Index?DocumentId=${id_documento}&InCommunity=False&InPaymentGateway=False&DocUniqueIdentifier=`,
    },
  };
}

function setup({ fetch = vi.fn() }: { fetch?: ReturnType<typeof vi.fn> } = {}) {
  let toolName = "";
  let config: Record<string, any> = {};
  let handler!: (input: {
    id_del_proceso: string;
    limit?: number;
    offset?: number;
  }) => Promise<any>;
  const server = {
    registerTool(
      name: string,
      options: Record<string, any>,
      callback: typeof handler,
    ) {
      toolName = name;
      config = options;
      handler = callback;
    },
  };
  const numberSchema = () => ({
    int: () => ({
      min: () => ({ max: () => ({ optional: () => ({ type: "number" }) }) }),
      max: () => ({ optional: () => ({ type: "number" }) }),
    }),
  });
  const deps = {
    socrataFetch:
      fetch as unknown as SecopDocumentsDependencies["socrataFetch"],
    tenderDataset: TENDER_DATASET,
    documentsDataset: DOCUMENTS_DATASET,
    stringSchema: () => ({ type: "string" }),
    numberSchema,
    env: {},
  } as unknown as SecopDocumentsDependencies;
  registerSecopDocumentsTool(server, deps);
  return { fetch, deps, getTool: () => ({ name: toolName, config, handler }) };
}

function resultData(result: any) {
  return JSON.parse(result.content[0].text);
}

describe("SECOP tender documents provider tool", () => {
  it("registers a readonly tool with bounded paging and resolves the tender's exact portfolio ID", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([tender])
      .mockResolvedValueOnce([documentRow("790490513")]);
    const { getTool } = setup({ fetch });
    const tool = getTool();

    expect(tool.name).toBe("documentos_licitacion");
    expect(tool.config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tool.config.inputSchema.limit).toBeDefined();
    expect(tool.config.inputSchema.offset).toBeDefined();

    const result = await tool.handler({ id_del_proceso: PROCESS_ID });
    expect(resultData(result)).toMatchObject({
      tender: {
        id_del_proceso: PROCESS_ID,
        id_del_portafolio: PORTFOLIO_ID,
      },
      association: {
        method: "exact_id_del_portafolio_equals_document_proceso",
        id_del_proceso: PROCESS_ID,
        id_del_portafolio: PORTFOLIO_ID,
      },
      data: [
        {
          id_del_proceso: PROCESS_ID,
          id_documento: "790490513",
          proceso: PORTFOLIO_ID,
          url_descarga_documento:
            "https://community.secop.gov.co/Public/Archive/RetrieveFile/Index?DocumentId=790490513&InCommunity=False&InPaymentGateway=False&DocUniqueIdentifier=",
        },
      ],
      pagination: { limit: 50, offset: 0, has_more: false },
    });
    expect(fetch.mock.calls).toEqual([
      [
        TENDER_DATASET,
        "SELECT id_del_proceso, id_del_portafolio, referencia_del_proceso, entidad, nit_entidad WHERE id_del_proceso = 'CO1.REQ.10391118' LIMIT 2",
        {},
      ],
      [
        DOCUMENTS_DATASET,
        "SELECT id_documento, proceso, nombre_archivo, tamanno_archivo, extensi_n, descripci_n, fecha_carga, entidad, nit_entidad, url_descarga_documento WHERE proceso = 'CO1.BDOS.10216199' ORDER BY fecha_carga DESC, id_documento DESC LIMIT 51 OFFSET 0",
        {},
      ],
    ]);
  });

  it("bounds paging, fetches one extra row, and reports whether another page exists", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([tender])
      .mockResolvedValueOnce([
        documentRow("3"),
        documentRow("2"),
        documentRow("1"),
      ]);
    const { deps } = setup({ fetch });
    const result = await readSecopDocuments(
      { id_del_proceso: PROCESS_ID, limit: 2, offset: 25 },
      deps,
    );

    expect(result.data.map((document) => document.id_documento)).toEqual([
      "3",
      "2",
    ]);
    expect(result.pagination).toEqual({ limit: 2, offset: 25, has_more: true });
    expect(fetch.mock.calls[1][1]).toContain("LIMIT 3 OFFSET 25");
  });

  it.each(["CO1.REQ.10391118' OR entidad IS NOT NULL --", "not-a-process-id"])(
    "rejects unsafe process IDs before making a Socrata request: %s",
    async (id) => {
      const fetch = vi.fn();
      const { deps } = setup({ fetch });
      await expect(
        readSecopDocuments({ id_del_proceso: id }, deps),
      ).rejects.toThrow("Invalid process ID");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: 10001 },
  ])("rejects out-of-range paging arguments: %o", async (paging) => {
    const fetch = vi.fn();
    const { deps } = setup({ fetch });
    await expect(
      readSecopDocuments({ id_del_proceso: PROCESS_ID, ...paging }, deps),
    ).rejects.toThrow(
      paging.limit === undefined ? "Invalid offset" : "Invalid limit",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns empty data when document rows do not prove the exact association", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([tender])
      .mockResolvedValueOnce([documentRow("1", "CO1.BDOS.OTHER")]);
    const { deps } = setup({ fetch });
    const result = await readSecopDocuments(
      { id_del_proceso: PROCESS_ID },
      deps,
    );
    expect(result.data).toEqual([]);
    expect(result.association).toMatchObject({
      status: "unresolved",
      reason: "document_process_id_mismatch",
    });
  });

  it("returns empty data with an explicit reason for unresolved tender association", async () => {
    for (const [tenderRows, reason] of [
      [[], "tender_not_found"],
      [[tender, tender], "tender_lookup_ambiguous"],
      [[{ ...tender, id_del_proceso: "CO1.REQ.OTHER" }], "tender_id_mismatch"],
      [
        [{ ...tender, id_del_portafolio: null }],
        "portfolio_id_missing_or_invalid",
      ],
    ] as const) {
      const fetch = vi.fn().mockResolvedValueOnce(tenderRows);
      const { deps } = setup({ fetch });
      const result = await readSecopDocuments(
        { id_del_proceso: PROCESS_ID },
        deps,
      );
      expect(result.data).toEqual([]);
      expect(result.association).toMatchObject({
        status: "unresolved",
        reason,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("exposes only validated HTTPS SECOP archive download URLs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([tender])
      .mockResolvedValueOnce([
        {
          ...documentRow("1"),
          url_descarga_documento: {
            url: "https://example.com/Public/Archive/RetrieveFile/Index?DocumentId=1",
          },
        },
        {
          ...documentRow("2"),
          url_descarga_documento: {
            url: "https://community.secop.gov.co/Public/Archive/RetrieveFile/Index?DocumentId=other",
          },
        },
      ]);
    const { deps } = setup({ fetch });
    const result = await readSecopDocuments(
      { id_del_proceso: PROCESS_ID },
      deps,
    );
    expect(
      result.data.map((document) => document.url_descarga_documento),
    ).toEqual([null, null]);
  });

  it("surfaces an unresolved portfolio as an action error rather than an empty verified listing", async () => {
    const { getTool } = setup({ fetch: vi.fn().mockResolvedValueOnce([]) });
    await expect(
      getTool().handler({ id_del_proceso: PROCESS_ID }),
    ).rejects.toThrow("association could not be verified");
  });

  it("normalizes upstream lookup failures without returning source details", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new Error("private upstream detail"));
    const { deps } = setup({ fetch });
    await expect(
      readSecopDocuments({ id_del_proceso: PROCESS_ID }, deps),
    ).rejects.toThrow("Tender lookup failed");
  });
});
