import { cachedJson, isOpen, keyValid, requestKey, unauthorized } from "./cache";
import { createHandler } from "./mcp";
import { OPENAPI, scalarHtml } from "./openapi";
import {
  DATASETS,
  buildDocsQuery,
  buildProcesosQuery,
  page,
  socrataFetch,
  type Env,
} from "./socrata";

function num(v: string | null | undefined, def: number, max: number): number {
  const n = parseInt(v || "", 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

function pageUrls(req: Request, res: Record<string, unknown>): Record<string, unknown> {
  const out = { ...res };
  const set = (k: string, off: number | null) => {
    if (off === null || off === undefined) {
      out[k] = null;
      return;
    }
    const u = new URL(req.url);
    u.searchParams.set("offset", String(off));
    out[k] = u.toString();
  };
  set("next", (res["next_offset"] as number | null) ?? null);
  set("prev", (res["prev_offset"] as number | null) ?? null);
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return Response.json({ ok: true, mode: "live-worker" });
    if (path === "/openapi.json") return Response.json(OPENAPI);
    if (path === "/scalar")
      return new Response(scalarHtml("/openapi.json"), {
        headers: { "Content-Type": "text/html;charset=utf-8" },
      });
    if (path === "/mcp") {
      if (!keyValid(env, requestKey(req))) return unauthorized();
      return (createHandler(env) as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(req);
    }

    if (!isOpen(path) && !keyValid(env, requestKey(req))) return unauthorized();
    const q = (k: string) => url.searchParams.get(k) ?? undefined;

    if (path === "/licitaciones") {
      const limit = num(q("limit"), 20, 100);
      const offset = num(q("offset"), 0, 1_000_000);
      return cachedJson(req, env, async () => {
        const soql = buildProcesosQuery({
          estado: q("estado"), entidad: q("entidad"), modalidad: q("modalidad"),
          departamento: q("departamento"), q: q("q"), desde: q("desde"),
          hasta: q("hasta"), limit, offset,
        });
        return pageUrls(req, page(await socrataFetch(DATASETS.procesos, soql, env), limit, offset));
      });
    }

    const mLic = path.match(/^\/licitaciones\/(.+)$/);
    if (mLic) {
      const rows = await socrataFetch(
        DATASETS.procesos,
        `SELECT *, :id WHERE id_del_proceso = '${decodeURIComponent(mLic[1]).replace(/'/g, "''")}' LIMIT 100`,
        env,
      );
      if (!rows.length) return Response.json({ detail: "not found" }, { status: 404 });
      return Response.json({ id_del_proceso: decodeURIComponent(mLic[1]), filas: rows });
    }

    if (path === "/documentos/search") {
      const qq = q("q");
      if (!qq) return Response.json({ detail: "q required" }, { status: 400 });
      const limit = num(q("limit"), 20, 100);
      const offset = num(q("offset"), 0, 1_000_000);
      return cachedJson(req, env, async () => {
        const soql = buildDocsQuery(qq, q("entidad"), limit, offset);
        const res = page(await socrataFetch(DATASETS.docs, soql, env), limit, offset);
        return pageUrls(req, { ...res, q: qq });
      });
    }

    return Response.json({ detail: "not found" }, { status: 404 });
  },
};
