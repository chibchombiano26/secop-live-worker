const SECOP_CATALOG_COLUMNS = Object.freeze({
  departamento: "departamento_entidad",
  entidad: "entidad",
  modalidad: "modalidad_de_contratacion",
});
const SECOP_CATALOG_LIMIT = 50000;
const SECOP_CATALOG_MAX_BYTES = 800000;
const SECOP_CATALOG_CACHE_TTL_SECONDS = 6 * 60 * 60;
const SECOP_CATALOG_CACHE_TTL_MS = SECOP_CATALOG_CACHE_TTL_SECONDS * 1000;
const SECOP_CATALOG_PENDING = new Map();

function secopCatalogCacheFor(deps) {
  return deps.cache ?? deps.env?.CATALOG_CACHE ?? globalThis.caches?.default;
}

function secopCatalogHost(env) {
  return String(env?.SOCRATA_DOMAIN || "www.datos.gov.co")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function secopCatalogKvKey(host, dataset, campo) {
  return `secop-catalog:v1:${host}:${dataset}:${campo}`;
}

function secopCatalogCacheKey(host, dataset, campo) {
  return new Request(
    `https://${host}/resource/${encodeURIComponent(dataset)}.json?__secop_catalog=${encodeURIComponent(campo)}`,
  );
}

function secopCatalogQuery(column) {
  return `SELECT ${column} AS value WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY ${column} LIMIT ${SECOP_CATALOG_LIMIT}`;
}

function secopCatalogParseRows(rows) {
  if (!Array.isArray(rows)) throw new Error("Catalog request failed");
  if (rows.length >= SECOP_CATALOG_LIMIT)
    throw new Error("Catalog result may be incomplete");

  const seen = new Set();
  const values = [];
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.value !== "string"
    ) {
      throw new Error("Catalog request failed");
    }
    const value = row.value.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

function secopCatalogEnvelope(campo, values, updatedAt) {
  return {
    id: campo,
    values,
    count: values.length,
    complete: true,
    updated_at: updatedAt,
  };
}

function secopCatalogJsonResponse(envelope) {
  const body = JSON.stringify({ data: [envelope] });
  if (new TextEncoder().encode(body).byteLength > SECOP_CATALOG_MAX_BYTES) {
    throw new Error("Catalog response is too large");
  }
  const ageMs = Math.max(0, Date.now() - Date.parse(envelope.updated_at));
  const maxAge = Math.max(
    0,
    Math.floor((SECOP_CATALOG_CACHE_TTL_MS - ageMs) / 1000),
  );
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
}

function secopCatalogAssertSize(envelope) {
  const body = JSON.stringify({ data: [envelope] });
  if (new TextEncoder().encode(body).byteLength > SECOP_CATALOG_MAX_BYTES) {
    throw new Error("Catalog response is too large");
  }
}

function secopCatalogIsValidSnapshot(envelope, campo) {
  return Boolean(
    envelope?.id === campo &&
    envelope?.complete === true &&
    Array.isArray(envelope.values) &&
    envelope.values.length < SECOP_CATALOG_LIMIT &&
    envelope.values.every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length < SECOP_CATALOG_LIMIT &&
        value === value.trim(),
    ) &&
    new Set(envelope.values).size === envelope.values.length &&
    envelope.count === envelope.values.length &&
    typeof envelope.updated_at === "string" &&
    Number.isFinite(Date.parse(envelope.updated_at)),
  );
}

function secopCatalogIsFresh(envelope) {
  return (
    Date.now() - Date.parse(envelope.updated_at) < SECOP_CATALOG_CACHE_TTL_MS
  );
}

function secopCatalogScheduleRefresh(campo, deps, host, kvKey, edgeKey) {
  const pendingKey = `${host}:${deps.dataset}:${campo}`;
  if (SECOP_CATALOG_PENDING.has(pendingKey)) {
    return SECOP_CATALOG_PENDING.get(pendingKey);
  }

  const pending = (async () => {
    const envelope = await secopCatalogReadUncached(campo, deps);
    secopCatalogAssertSize(envelope);
    const response = secopCatalogJsonResponse(envelope);
    const kv = deps.env?.CATALOG_KV;
    if (kv) {
      try {
        await kv.put(kvKey, JSON.stringify(envelope));
      } catch {
        // Catalog reads still succeed if the durable cache is unavailable.
      }
    }
    const cache = secopCatalogCacheFor(deps);
    if (cache) {
      try {
        await cache.put(edgeKey, response.clone());
      } catch {
        // Edge cache writes are best-effort.
      }
    }
    return envelope;
  })();
  const tracked = pending.finally(() => {
    if (SECOP_CATALOG_PENDING.get(pendingKey) === tracked) {
      SECOP_CATALOG_PENDING.delete(pendingKey);
    }
  });
  SECOP_CATALOG_PENDING.set(pendingKey, tracked);
  return tracked;
}

function secopCatalogReturnStaleOrRefresh(
  envelope,
  campo,
  deps,
  host,
  kvKey,
  edgeKey,
) {
  const refresh = secopCatalogScheduleRefresh(
    campo,
    deps,
    host,
    kvKey,
    edgeKey,
  );
  if (typeof deps.waitUntil === "function") {
    try {
      deps.waitUntil(refresh.catch(() => undefined));
      return Promise.resolve(envelope);
    } catch {
      // If the runtime rejects waitUntil, finish refresh before returning.
    }
  }
  return refresh;
}

async function secopCatalogReadUncached(campo, deps) {
  const column = SECOP_CATALOG_COLUMNS[campo];
  let rows;
  try {
    rows = await deps.socrataFetch(
      deps.dataset,
      secopCatalogQuery(column),
      deps.env,
    );
  } catch {
    throw new Error("Catalog request failed");
  }
  const values = secopCatalogParseRows(rows);
  return secopCatalogEnvelope(campo, values, new Date().toISOString());
}

/**
 * Read one complete, public SECOP catalog. Exported so the provider's REST
 * warming route and the MCP tool share validation, caching, and coalescing.
 */
export async function readSecopCatalog(campo, deps) {
  if (!Object.hasOwn(SECOP_CATALOG_COLUMNS, campo)) {
    throw new Error("Unsupported catalog field");
  }

  const host = secopCatalogHost(deps.env);
  const kvKey = secopCatalogKvKey(host, deps.dataset, campo);
  const key = secopCatalogCacheKey(host, deps.dataset, campo);
  const kv = deps.env?.CATALOG_KV;
  if (kv) {
    try {
      const cached = await kv.get(kvKey, "json");
      if (secopCatalogIsValidSnapshot(cached, campo)) {
        secopCatalogAssertSize(cached);
        if (secopCatalogIsFresh(cached)) return cached;
        return secopCatalogReturnStaleOrRefresh(
          cached,
          campo,
          deps,
          host,
          kvKey,
          key,
        );
      }
    } catch {
      // Invalid or unavailable KV data falls through to the edge cache.
    }
  }

  const cache = secopCatalogCacheFor(deps);
  if (cache) {
    try {
      const cached = await cache.match(key);
      if (cached) {
        const payload = await cached.json();
        const envelope = payload?.data?.[0];
        if (secopCatalogIsValidSnapshot(envelope, campo)) {
          secopCatalogAssertSize(envelope);
          if (secopCatalogIsFresh(envelope)) return envelope;
          return secopCatalogReturnStaleOrRefresh(
            envelope,
            campo,
            deps,
            host,
            kvKey,
            key,
          );
        }
      }
    } catch {
      // A cache read failure is a miss; public catalog data can be refetched.
    }
  }

  return secopCatalogScheduleRefresh(campo, deps, host, kvKey, key);
}

export function registerSecopCatalogTool(server, deps) {
  server.registerTool(
    "opciones_licitaciones",
    {
      description:
        "Returns the complete SECOP II catalog of departments, contracting entities, or contracting modalities.",
      inputSchema: { campo: deps.stringSchema() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ campo }) => {
      const envelope = await readSecopCatalog(campo, deps);
      const serialized = JSON.stringify({ data: [envelope] });
      if (
        new TextEncoder().encode(serialized).byteLength >
        SECOP_CATALOG_MAX_BYTES
      ) {
        throw new Error("Catalog response is too large");
      }
      return { content: [{ type: "text", text: serialized }] };
    },
  );
}
