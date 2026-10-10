import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
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
import { cachedJson, isOpen, keyValid, requestKey, unauthorized } from "./cache";

type OAuthEnv = Env & {
  OAUTH_PROVIDER: {
    parseAuthRequest(r: Request): Promise<unknown>;
    describeConsent(r: unknown): Promise<{
      clientName: string; clientDomain: string | null; redirectHost: string;
      redirectIsLoopback: boolean; scope: string[];
    }>;
    beginConsent(r: unknown): Promise<{ handle: string; headers: Headers }>;
    approveConsent(r: Request, handle: string, o?: { scope?: string[] }): Promise<{ request: unknown; headers: Headers }>;
    denyConsent(r: Request, handle: string): Promise<{ headers: Headers } & Record<string, unknown>>;
    completeAuthorization(o: { request: unknown; userId: string; metadata: unknown; scope: string[]; props: unknown }): Promise<{ redirectTo: string }>;
  };
};

function num(v: string | null | undefined, def: number, max: number): number {
  const n = parseInt(v || "", 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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

function validCode(env: Env, code: string | null): boolean {
  const keys = (env.API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  return !!code && (keys.length === 0 || keys.includes(code));
}

async function authorizePage(req: Request, env: OAuthEnv, err = ""): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let authReq: unknown;
  try {
    authReq = await oauth.parseAuthRequest(req);
  } catch {
    return Response.json({ detail: "invalid authorize request" }, { status: 400 });
  }
  const details = await oauth.describeConsent(authReq);
  const consent = await oauth.beginConsent(authReq);
  const scopes = details.scope.map((s) => `<li>${esc(s)}</li>`).join("");
  const html = `<!doctype html><meta charset="utf-8">
<title>Authorize ${esc(details.clientName)} — SECOP Live</title>
<h1>Allow ${esc(details.clientName)} to search SECOP?</h1>
<p>${details.clientDomain ? `Published by <strong>${esc(details.clientDomain)}</strong>.` : "This app registered itself; its name is not verified."}
Access will be sent to <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>Sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>Scopes requested:</p><ul>${scopes}</ul>
${err ? `<p style="color:red">${esc(err)}</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${esc(consent.handle)}">
<p><label>Access code (your SECOP API key):<br><input type="password" name="code" autocomplete="off"></label></p>
<p><button name="decision" value="approve">Allow</button>
<button name="decision" value="deny">Deny</button></p>
</form>`;
  const headers = new Headers({ "Content-Type": "text/html;charset=utf-8" });
  consent.headers.forEach((v, k) => headers.append(k, v));
  return new Response(html, { headers });
}

async function authorizeSubmit(req: Request, env: OAuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await req.formData();
  const handle = String(form.get("handle") || "");
  const decision = String(form.get("decision") || "");
  if (decision !== "approve") {
    const denied = (await oauth.denyConsent(req, handle)) as unknown as { redirectTo: string; headers: Headers };
    const headers = new Headers({ Location: denied.redirectTo });
    denied.headers.forEach((v, k) => headers.append(k, v));
    return new Response(null, { status: 302, headers });
  }
  const code = String(form.get("code") || "");
  if (!validCode(env, code)) {
    return authorizePage(req, env, "Invalid access code.");
  }
  const approved = await oauth.approveConsent(req, handle);
  const done = await oauth.completeAuthorization({
    request: approved.request,
    userId: "secop-user",
    metadata: {},
    scope: ["mcp:read"],
    props: {},
  });
  const headers = new Headers(approved.headers as Headers);
  headers.set("Location", done.redirectTo);
  return new Response(null, { status: 302, headers });
}

async function handleRest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") return Response.json({ ok: true, mode: "live-worker" });
  if (path === "/openapi.json") return Response.json(OPENAPI);
  if (path === "/scalar")
    return new Response(scalarHtml("/openapi.json"), {
      headers: { "Content-Type": "text/html;charset=utf-8" },
    });
  if (path === "/authorize") {
    if (req.method === "POST") return authorizeSubmit(req, env as OAuthEnv);
    return authorizePage(req, env as OAuthEnv);
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
}

function providerFor(req: Request) {
  // Canonical resource URLs depend on the public hostname, which varies
  // (workers.dev subdomain vs custom domain), so build the provider per
  // request. Construction is pure config (no I/O).
  const base = new URL(req.url).origin;
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (r: Request, env: Cloudflare.Env) =>
        (createHandler(env as unknown as Env) as unknown as { fetch: (x: Request) => Promise<Response> }).fetch(r),
    },
    defaultHandler: {
      fetch: (r: Request, env: Cloudflare.Env) => handleRest(r, env as unknown as Env),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["mcp:read", "offline_access"],
    requiredScopes: ["mcp:read"],
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${base}/mcp`,
      authorization_servers: [base],
    },
  });
}

export default {
  fetch: (req: Request, env: Cloudflare.Env, ctx: ExecutionContext) =>
    providerFor(req).fetch(req, env, ctx),
};
