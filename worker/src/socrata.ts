export interface Env extends Record<string, unknown> {
  API_KEYS?: string;
  PRIVATE_AUTH_PEPPER?: string;
  PRIVATE_CONNECTIONS?: string;
  SOCRATA_APP_TOKEN?: string;
  CACHE_TTL?: string;
  SOCRATA_DOMAIN?: string;
}

export const DATASETS = {
  procesos: "p6dx-8zbt",
  docs: "dmgg-8hin",
} as const;

export const MAX_LIMIT = 100;
export const MAX_FILTER_VALUES = 20;
export const MAX_FILTER_VALUE_LENGTH = 500;

export type StringFilter = string | string[];

export function parseRepeatedFilter(values: string[]): StringFilter | undefined {
  if (!values.length) return undefined;
  return values.length === 1 ? values[0] : values;
}

function filterValues(value: StringFilter): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length < 1 ||
    values.length > MAX_FILTER_VALUES ||
    values.some(
      (item) =>
        typeof item !== "string" ||
        item.trim().length === 0 ||
        item.length > MAX_FILTER_VALUE_LENGTH,
    )
  ) {
    throw new Error("Invalid filter values");
  }
  return values;
}

function filterAny(values: string[], predicate: (value: string) => string) {
  if (values.length === 1) return predicate(values[0]);
  return `(${values.map(predicate).join(" OR ")})`;
}

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
  estado?: StringFilter;
  entidad?: StringFilter;
  modalidad?: StringFilter;
  departamento?: StringFilter;
  q?: string;
  desde?: string;
  hasta?: string;
  vigentes?: boolean;
  limit?: number;
  offset?: number;
}

const TERMINAL_STATES = [
  "Cancelado",
  "Adjudicado",
  "Seleccionado",
  "Cerrado",
  "Terminado",
  "Finalizado",
  "Liquidado",
  "Desierto",
  "Revocado",
  "Suspendido",
  "Evaluación",
  "En evaluación",
  "Borrador",
];

/** Socrata stores these as floating local timestamps. Colombia is UTC-5 year-round. */
export function colombianFloatingTimestamp(now: Date): string {
  return new Date(now.getTime() - 5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19);
}

export function buildProcesosQuery(f: ProcesoFilters, now = new Date()): string {
  const limit = Math.max(1, Math.min(f.limit ?? 20, MAX_LIMIT));
  const offset = Math.max(0, f.offset ?? 0);
  const w: string[] = [];
  if (f.estado !== undefined)
    w.push(
      filterAny(filterValues(f.estado), (value) => `estado_del_procedimiento = '${esc(value)}'`),
    );
  if (f.entidad !== undefined)
    w.push(filterAny(filterValues(f.entidad), (value) => like("entidad", value)));
  if (f.modalidad !== undefined)
    w.push(
      filterAny(filterValues(f.modalidad), (value) =>
        like("modalidad_de_contratacion", value),
      ),
    );
  if (f.departamento !== undefined)
    w.push(
      filterAny(filterValues(f.departamento), (value) =>
        like("departamento_entidad", value),
      ),
    );
  if (f.desde) w.push(`fecha_de_publicacion_del >= '${esc(f.desde)}'`);
  if (f.hasta) w.push(`fecha_de_publicacion_del <= '${esc(f.hasta)}'`);
  if (f.vigentes) {
    w.push(`fecha_de_recepcion_de > '${colombianFloatingTimestamp(now)}'`);
    w.push(
      `upper(estado_del_procedimiento) NOT IN (${TERMINAL_STATES.map((state) => `'${state.toUpperCase()}'`).join(", ")})`,
    );
  }
  if (f.q)
    w.push(
      wordsAny(["nombre_del_procedimiento", "descripci_n_del_procedimiento"], f.q),
    );
  const where = w.length ? `WHERE ${w.join(" AND ")}` : "";
  return (
    `SELECT *, :id ${where} ORDER BY ${f.vigentes ? "fecha_de_recepcion_de ASC, :id" : "fecha_de_publicacion_del DESC, :id"}` +
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
