import {
  sweepExpiredProposals,
  sweepOriginalRetention,
} from "./dossier/retention";
import { privateApiRequest } from "./dossier/api";
import { dispatchJobs, processJob } from "./dossier/jobs";
import {
  executeProcessingJob,
  recoverTerminalExtractions,
  type ProcessingEnv,
} from "./dossier/processing";
import { authorizePrivateCode } from "./dossier/authorization";
import { PRIVATE_SCOPES } from "./dossier/contracts";
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
import {
  cachedJson,
  isOpen,
  keyValid,
  requestKey,
  unauthorized,
} from "./cache";

type OAuthEnv = Env & {
  OAUTH_PROVIDER: {
    parseAuthRequest(r: Request): Promise<unknown>;
    describeConsent(r: unknown): Promise<{
      clientName: string;
      clientDomain: string | null;
      redirectHost: string;
      redirectIsLoopback: boolean;
      scope: string[];
    }>;
    beginConsent(r: unknown): Promise<{ handle: string; headers: Headers }>;
    approveConsent(
      r: Request,
      handle: string,
      o?: { scope?: string[] },
    ): Promise<{ request: unknown; headers: Headers }>;
    denyConsent(
      r: Request,
      handle: string,
    ): Promise<{ headers: Headers } & Record<string, unknown>>;
    completeAuthorization(o: {
      request: unknown;
      userId: string;
      metadata: unknown;
      scope: string[];
      props: unknown;
    }): Promise<{ redirectTo: string }>;
  };
};

function num(v: string | null | undefined, def: number, max: number): number {
  const n = parseInt(v || "", 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

const esc = (v: string) =>
  v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function pageUrls(
  req: Request,
  res: Record<string, unknown>,
): Record<string, unknown> {
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
  const keys = (env.API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return !!code && keys.length > 0 && keys.includes(code);
}

async function authorizePage(
  req: Request,
  env: OAuthEnv,
  err = "",
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let authReq: unknown;
  try {
    authReq = await oauth.parseAuthRequest(req);
  } catch {
    return Response.json(
      { detail: "invalid authorize request" },
      { status: 400 },
    );
  }
  const details = await oauth.describeConsent(authReq);
  const consent = await oauth.beginConsent(authReq);
  const privateConsent = details.scope.some((scope) =>
    (PRIVATE_SCOPES as readonly string[]).includes(scope),
  );
  const scopes = details.scope
    .map((s) => `<span class="chip">${esc(s)}</span>`)
    .join("");
  const html = `<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autorizar ${esc(details.clientName)} · SECOP Live</title>
<style>
:root{--bg:#0b1220;--card:#131c31;--line:#24314f;--txt:#e8eefc;--mut:#93a1c0;--acc:#3b82f6;--acc2:#22c55e;--warn:#f59e0b;--err:#ef4444}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 600px at 50% -10%,#1a2b52 0%,var(--bg) 60%);color:var(--txt);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px;box-shadow:0 24px 64px rgba(0,0,0,.45)}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:4px}.dot{width:12px;height:12px;border-radius:50%;background:linear-gradient(135deg,#facc15,#f97316)}.brand{font-weight:700;letter-spacing:.4px}.brand small{display:block;font-weight:400;color:var(--mut);font-size:12px}
h1{font-size:21px;margin:14px 0 6px}.app{color:#fff}.mut{color:var(--mut);font-size:14px}.box{background:#0d1528;border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:14px;margin:14px 0}
.warn{border-color:var(--warn);color:#fde68a}.errbox{border-color:var(--err);color:#fecaca}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0}.chip{background:#1e2a47;border:1px solid var(--line);border-radius:999px;padding:3px 12px;font-size:13px;font-family:ui-monospace,monospace}
label{display:block;font-size:14px;margin:14px 0 6px}input[type=password]{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#0d1528;color:var(--txt);font-size:15px}input:focus{outline:2px solid var(--acc);border-color:var(--acc)}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;padding:12px;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}.allow{background:var(--acc2);color:#05240f}.deny{background:transparent;color:var(--mut);border:1px solid var(--line);flex:.6}.allow:hover{filter:brightness(1.1)}
.err{color:var(--err);font-size:14px;margin-top:10px}
.foot{margin-top:18px;font-size:12px;color:var(--mut);text-align:center}
</style>
<div class="card">
<div class="logo"><span class="dot"></span><span class="brand">SECOP Live<small>Colombia · Contratación pública</small></span></div>
<h1>¿Permitir a <span class="app">${esc(details.clientName)}</span> consultar SECOP?</h1>
<p class="mut">${details.clientDomain ? `Publicado por <strong style="color:var(--txt)">${esc(details.clientDomain)}</strong>.` : "Esta app se registró sola; su nombre no está verificado."}
El acceso se enviará a <strong style="color:var(--txt)">${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? `<div class="box warn">⚠️ El acceso llega a una app en <strong>tu computador</strong>. Continúa solo si acabas de iniciar sesión desde ella.</div>` : ""}
<div class="box"><div class="mut">Permisos solicitados</div><div class="chips">${scopes}</div></div>
${err ? `<div class="box errbox">⛔ ${esc(err)}</div>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${esc(consent.handle)}">
<label for="code">Clave de acceso (tu API key de SECOP Live)</label>
<input id="code" type="password" name="code" autocomplete="off" placeholder="••••••••" autofocus>
<div class="row"><button class="deny" name="decision" value="deny">Denegar</button><button class="allow" name="decision" value="approve">Permitir</button></div>
${err ? `<div class="err">${esc(err)}</div>` : ""}
</form>
<div class="foot">${privateConsent ? `Expediente privado: guarda documentos de empresa, analiza evidencia y conserva conversaciones. Procesamiento con ${esc(String(env.AI_PROVIDER_LABEL || "el proveedor de IA configurado por el administrador"))}. Usa esta conexión únicamente en un espacio de Savia.` : "Solo lectura: búsqueda de licitaciones y documentos. Nada se modifica."}</div>
</div>`;
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
    const denied = (await oauth.denyConsent(req, handle)) as unknown as {
      redirectTo: string;
      headers: Headers;
    };
    const headers = new Headers({ Location: denied.redirectTo });
    denied.headers.forEach((v, k) => headers.append(k, v));
    return new Response(null, { status: 302, headers });
  }
  const code = String(form.get("code") || "");
  const approved = await oauth.approveConsent(req, handle);
  const details = await oauth.describeConsent(approved.request);
  const privateRequested = details.scope.some((scope) =>
    (PRIVATE_SCOPES as readonly string[]).includes(scope),
  );
  let props: unknown = {};
  let userId = "secop-user";
  let granted: string[] = details.scope.filter(
    (scope) => scope === "mcp:read" || scope === "offline_access",
  );
  if (privateRequested) {
    try {
      const context = await authorizePrivateCode(env, code, details.scope);
      props = context;
      userId = context.ownerId;
      granted = [...granted, ...context.scopes];
    } catch {
      return Response.json(
        {
          error:
            "Private connection authorization denied. Restart authorization with a valid private access code.",
        },
        { status: 403 },
      );
    }
  } else if (!validCode(env, code)) {
    return Response.json(
      { error: "Invalid access code. Restart authorization." },
      { status: 403 },
    );
  }
  const done = await oauth.completeAuthorization({
    request: approved.request,
    userId,
    metadata: {},
    scope: granted,
    props,
  });
  const headers = new Headers(approved.headers as Headers);
  headers.set("Location", done.redirectTo);
  return new Response(null, { status: 302, headers });
}

async function handleRest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path.startsWith("/private/")) return privateApiRequest(req, env);

  if (path === "/health")
    return Response.json({ ok: true, mode: "live-worker" });
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
    const load = async () => {
      const soql = buildProcesosQuery({
        estado: q("estado"),
        entidad: q("entidad"),
        modalidad: q("modalidad"),
        departamento: q("departamento"),
        q: q("q"),
        desde: q("desde"),
        hasta: q("hasta"),
        vigentes: q("vigentes") === "true",
        limit,
        offset,
      });
      return pageUrls(
        req,
        page(await socrataFetch(DATASETS.procesos, soql, env), limit, offset),
      );
    };
    // A cached future deadline can expire while the response remains cached.
    if (q("vigentes") === "true") return Response.json(await load(), { headers: { "Cache-Control": "no-store" } });
    return cachedJson(req, env, load);
  }

  const mLic = path.match(/^\/licitaciones\/(.+)$/);
  if (mLic) {
    const rows = await socrataFetch(
      DATASETS.procesos,
      `SELECT *, :id WHERE id_del_proceso = '${decodeURIComponent(mLic[1]).replace(/'/g, "''")}' LIMIT 100`,
      env,
    );
    if (!rows.length)
      return Response.json({ detail: "not found" }, { status: 404 });
    return Response.json({
      id_del_proceso: decodeURIComponent(mLic[1]),
      filas: rows,
    });
  }

  if (path === "/documentos/search") {
    const qq = q("q");
    if (!qq) return Response.json({ detail: "q required" }, { status: 400 });
    const limit = num(q("limit"), 20, 100);
    const offset = num(q("offset"), 0, 1_000_000);
    return cachedJson(req, env, async () => {
      const soql = buildDocsQuery(qq, q("entidad"), limit, offset);
      const res = page(
        await socrataFetch(DATASETS.docs, soql, env),
        limit,
        offset,
      );
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
      fetch: (r: Request, env: Cloudflare.Env, ctx: ExecutionContext) =>
        (
          createHandler(
            env as unknown as Env,
            (ctx as ExecutionContext & { props?: unknown }).props,
            new URL(r.url).origin,
          ) as unknown as { fetch: (x: Request) => Promise<Response> }
        ).fetch(r),
    },
    defaultHandler: {
      fetch: (r: Request, env: Cloudflare.Env) =>
        handleRest(r, env as unknown as Env),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["mcp:read", "offline_access", ...PRIVATE_SCOPES],
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
  scheduled: (
    _event: ScheduledController,
    env: ProcessingEnv,
    ctx: ExecutionContext,
  ) => {
    ctx.waitUntil(
      Promise.all([
        dispatchJobs(env),
        sweepOriginalRetention(env),
        sweepExpiredProposals(env),
        recoverTerminalExtractions(env),
      ]),
    );
  },
  queue: async (
    batch: MessageBatch<{ ownerId: string; jobId: string }>,
    env: ProcessingEnv,
  ) => {
    for (const message of batch.messages) {
      try {
        await processJob(env, message.body, (repo, job) =>
          executeProcessingJob(repo, job, env),
        );
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
  },
};
