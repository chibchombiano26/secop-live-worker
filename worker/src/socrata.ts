export interface Env extends Record<string, unknown> {
  API_KEYS?: string;
  SOCRATA_APP_TOKEN?: string;
  CACHE_TTL?: string;
  SOCRATA_DOMAIN?: string;
}

export const DATASETS = {
  procesos: "p6dx-8zbt",
  docs: "dmgg-8hin",
} as const;

export const MAX_LIMIT = 100;

export function esc(v: string): string {
  return v.replace(/'/g, "''");
}

export function like(col: string, v: string): string {
  return `upper(${col}) like '%${esc(v.toUpperCase())}%'`;
}

/** Every word must appear in at least one of the columns (AND of ORs),
 *  so agents can ask in natural language. */
export function wordsAny(cols: string[], q: string): string {
  const conds = q
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const e = esc(w.toUpperCase());
      return `(${cols.map((c) => `upper(${c}) like '%${e}%'`).join(" OR ")})`;
    });
  return conds.length ? `(${conds.join(" AND ")})` : "(1 = 1)";
}

export interface ProcesoFilters {
  estado?: string;
  entidad?: string;
  modalidad?: string;
  departamento?: string;
  q?: string;
  desde?: string;
  hasta?: string;
  limit?: number;
  offset?: number;
}

export function buildProcesosQuery(f: ProcesoFilters): string {
  const limit = Math.max(1, Math.min(f.limit ?? 20, MAX_LIMIT));
  const offset = Math.max(0, f.offset ?? 0);
  const w: string[] = [];
  if (f.estado) w.push(`estado_del_procedimiento = '${esc(f.estado)}'`);
  if (f.entidad) w.push(like("entidad", f.entidad));
  if (f.modalidad) w.push(like("modalidad_de_contratacion", f.modalidad));
  if (f.departamento) w.push(like("departamento_entidad", f.departamento));
  if (f.desde) w.push(`fecha_de_publicacion_del >= '${esc(f.desde)}'`);
  if (f.hasta) w.push(`fecha_de_publicacion_del <= '${esc(f.hasta)}'`);
  if (f.q)
    w.push(
      wordsAny(["nombre_del_procedimiento", "descripci_n_del_procedimiento"], f.q),
    );
  const where = w.length ? `WHERE ${w.join(" AND ")}` : "";
  return (
    `SELECT *, :id ${where} ORDER BY fecha_de_publicacion_del DESC, :id` +
    ` LIMIT ${limit} OFFSET ${offset}`
  );
}

export function buildDocsQuery(q: string, entidad?: string, limit = 20, offset = 0): string {
  limit = Math.max(1, Math.min(limit, MAX_LIMIT));
  offset = Math.max(0, offset);
  const w = [wordsAny(["nombre_archivo", "descripci_n"], q)];
  if (entidad) w.push(like("entidad", entidad));
  return (
    `SELECT *, :id WHERE ${w.join(" AND ")} ORDER BY fecha_carga DESC, :id` +
    ` LIMIT ${limit} OFFSET ${offset}`
  );
}

export async function socrataFetch(dataset: string, soql: string, env: Env): Promise<unknown[]> {
  const url =
    `https://${env.SOCRATA_DOMAIN || "www.datos.gov.co"}/resource/${dataset}.json` +
    `?${new URLSearchParams({ $query: soql })}`;
  const headers: Record<string, string> = { "User-Agent": "secop-live-worker/1.0" };
  if (env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = env.SOCRATA_APP_TOKEN;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Socrata HTTP ${r.status}: ${await r.text().then((t) => t.slice(0, 200))}`);
  const data = (await r.json()) as unknown;
  return Array.isArray(data) ? data : [];
}

export function page(data: unknown[], limit: number, offset: number) {
  return {
    limit,
    offset,
    next_offset: data.length === limit ? offset + limit : null,
    prev_offset: offset - limit >= 0 ? offset - limit : null,
    data,
  };
}
