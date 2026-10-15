import { registerDossierTools } from "./dossier/tools";
import { readSecopCatalog } from "./public/catalogs.mjs";
import { readSecopDocuments } from "./public/documents.mjs";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  DATASETS,
  buildDocsQuery,
  buildProcesosQuery,
  page,
  socrataFetch,
} from "./socrata";
import type { Env } from "./socrata";

export function createHandler(
  env: Env,
  privateContext?: unknown,
  origin = "http://localhost",
) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: "secop-live", version: "1.0.0" });

    server.registerTool(
      "buscar_licitaciones",
      {
        description:
          "Search Colombia SECOP tenders live (full history + just published). Filter by estado (e.g. Publicado), entidad, modalidad, departamento, natural-language text. Use offset/next_offset to paginate.",
        inputSchema: {
          q: z.string().optional(),
          estado: z.string().optional(),
          entidad: z.string().optional(),
          modalidad: z.string().optional(),
          departamento: z.string().optional(),
          limit: z.number().optional(),
          offset: z.number().optional(),
        },
      },
      async (a) => {
        const limit = a.limit ?? 20;
        const offset = a.offset ?? 0;
        const soql = buildProcesosQuery({
          q: a.q,
          estado: a.estado,
          entidad: a.entidad,
          modalidad: a.modalidad,
          departamento: a.departamento,
          limit,
          offset,
        });
        const data = await socrataFetch(DATASETS.procesos, soql, env);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(page(data, limit, offset)),
            },
          ],
        };
      },
    );

    server.registerTool(
      "detalle_licitacion",
      {
        description:
          "Full detail of one tender by ID (CO1.REQ.xxx). May return several rows (one per awardee).",
        inputSchema: { id_del_proceso: z.string() },
      },
      async (a) => {
        const data = await socrataFetch(
          DATASETS.procesos,
          `SELECT *, :id WHERE id_del_proceso = '${a.id_del_proceso.replace(/'/g, "''")}' LIMIT 100`,
          env,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id_del_proceso: a.id_del_proceso,
                filas: data,
              }),
            },
          ],
        };
      },
    );

    server.registerTool(
      "buscar_documentos",
      {
        description:
          "Search SECOP documents live by filename/description, optionally by entity.",
        inputSchema: {
          q: z.string(),
          entidad: z.string().optional(),
          limit: z.number().optional(),
          offset: z.number().optional(),
        },
      },
      async (a) => {
        const limit = a.limit ?? 10;
        const offset = a.offset ?? 0;
        const soql = buildDocsQuery(a.q, a.entidad, limit, offset);
        const data = await socrataFetch(DATASETS.docs, soql, env);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ q: a.q, ...page(data, limit, offset) }),
            },
          ],
        };
      },
    );

    server.registerTool(
      "opciones_licitaciones",
      {
        description: "Complete SECOP department, entity and modality catalogs.",
        inputSchema: {
          campo: z.enum(["departamento", "entidad", "modalidad"]),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async ({ campo }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: [
                await readSecopCatalog(campo, {
                  env,
                  dataset: DATASETS.procesos,
                  socrataFetch,
                  stringSchema: () => z.string(),
                }),
              ],
            }),
          },
        ],
      }),
    );
    server.registerTool(
      "documentos_licitacion",
      {
        description:
          "Official documents linked by exact tender portfolio identity.",
        inputSchema: {
          id_del_proceso: z.string(),
          limit: z.number().int().min(1).max(100).optional(),
          offset: z.number().int().min(0).max(10000).optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (input) => {
        const result = await readSecopDocuments(input, {
          env,
          tenderDataset: DATASETS.procesos,
          documentsDataset: DATASETS.docs,
          socrataFetch,
          stringSchema: () => z.string(),
          numberSchema: () => z.number(),
        });
        if (result.association.status !== "verified")
          throw new Error(
            "The tender document association could not be verified.",
          );
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );
    registerDossierTools(server, env, privateContext, origin);
    return server;
  });
}
