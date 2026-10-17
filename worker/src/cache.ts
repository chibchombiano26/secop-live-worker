import type { Env } from "./socrata";

const OPEN_PATHS = new Set(["/health", "/scalar", "/openapi.json"]);

export function keyValid(env: Env, key: string | null): boolean {
  const keys = (env.API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!keys.length) return true; // unconfigured: open (development)
  return !!key && keys.includes(key);
}

export function isOpen(path: string): boolean {
  return OPEN_PATHS.has(path);
}

export function requestKey(req: Request): string | null {
  return (
    req.headers.get("x-api-key") ||
    new URL(req.url).searchParams.get("api_key")
  );
}

export function unauthorized(): Response {
  return Response.json({ detail: "missing or invalid api key" }, { status: 401 });
}

/** Cache key: path + sorted params minus api_key/fresh. */
export function cacheKey(req: Request): Request {
  const u = new URL(req.url);
  u.searchParams.delete("api_key");
  u.searchParams.delete("fresh");
  const entries: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => entries.push([k, v]));
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sorted = new URLSearchParams();
  for (const [k, v] of entries) sorted.append(k, v);
  return new Request(`${u.origin}${u.pathname}?${sorted}`, { method: "GET" });
}

export function wantFresh(req: Request): boolean {
  const v = new URL(req.url).searchParams.get("fresh");
  return v === "1" || v === "true";
}

export function ttl(env: Env): number {
  const t = parseInt(env.CACHE_TTL || "600", 10);
  return Number.isFinite(t) && t > 0 ? t : 600;
}

export async function cachedJson(
  req: Request,
  env: Env,
  loader: () => Promise<unknown>,
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = cacheKey(req);
  if (!wantFresh(req)) {
    const hit = await cache.match(key);
    if (hit) {
      const body = (await hit.json()) as Record<string, unknown>;
      body["cached"] = true;
      return Response.json(body, { headers: { "X-Cache": "HIT" } });
    }
  }
  const data = (await loader()) as Record<string, unknown>;
  data["cached"] = false;
  const res = Response.json(data, {
    headers: {
      "Cache-Control": `public, max-age=${ttl(env)}`,
      "X-Cache": "MISS",
    },
  });
  await cache.put(key, res.clone());
  return res;
}
