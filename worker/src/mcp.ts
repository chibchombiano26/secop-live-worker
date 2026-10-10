import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DATASETS, buildDocsQuery, buildProcesosQuery, page, socrataFetch } from "./socrata";
import type { Env } from "./socrata";

export function createHandler(env: Env) {
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
          q: a.q, estado: a.estado, entidad: a.entidad, modalidad: a.modalidad,
          departamento: a.departamento, limit, offset,
        });
        const data = await socrataFetch(DATASETS.procesos, soql, env);
        return { content: [{ type: "text" as const, text: JSON.stringify(page(data, limit, offset)) }] };
      },
    );

    server.registerTool(
      "detalle_licitacion",
      {
        description: "Full detail of one tender by ID (CO1.REQ.xxx). May return several rows (one per awardee).",
        inputSchema: { id_del_proceso: z.string() },
      },
      async (a) => {
        const data = await socrataFetch(
          DATASETS.procesos,
          `SELECT *, :id WHERE id_del_proceso = '${a.id_del_proceso.replace(/'/g, "''")}' LIMIT 100`,
          env,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify({ id_del_proceso: a.id_del_proceso, filas: data }) }] };
      },
    );

    server.registerTool(
      "buscar_documentos",
      {
        description: "Search SECOP documents live by filename/description, optionally by entity.",
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
        return { content: [{ type: "text" as const, text: JSON.stringify({ q: a.q, ...page(data, limit, offset) }) }] };
      },
    );

    return server;
  });
}
