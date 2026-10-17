import { z } from "zod/v4";
import {
  DossierError,
  privateContextSchema,
  scopeSchema,
  type PrivateContext,
  type PrivateAuthEnv,
} from "./contracts";
const credentialSchema = privateContextSchema.extend({
  codeDigest: z.string().regex(/^[0-9a-f]{64}$/),
  tokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.string().datetime().optional(),
});
export async function credentialDigest(
  pepper: string,
  kind: "code" | "token",
  value: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${kind}:${value}`),
    ),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function resolve(
  env: PrivateAuthEnv,
  kind: "code" | "token",
  value: string,
): Promise<PrivateContext> {
  if (
    !env.PRIVATE_AUTH_PEPPER ||
    env.PRIVATE_AUTH_PEPPER.length < 32 ||
    !env.PRIVATE_CONNECTIONS
  )
    throw new DossierError("PRIVATE_AUTH_UNCONFIGURED", 503);
  if (!value || value.length > 512)
    throw new DossierError("PRIVATE_UNAUTHORIZED", 401);
  let entries: z.infer<typeof credentialSchema>[];
  try {
    entries = z
      .array(credentialSchema)
      .max(1000)
      .parse(JSON.parse(env.PRIVATE_CONNECTIONS));
  } catch {
    throw new DossierError("PRIVATE_AUTH_UNCONFIGURED", 503);
  }
  const digest = await credentialDigest(env.PRIVATE_AUTH_PEPPER, kind, value);
  const matches = entries.filter(
    (e) => e[kind === "code" ? "codeDigest" : "tokenDigest"] === digest,
  );
  const entry = matches.length === 1 ? matches[0] : undefined;
  if (!entry || (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()))
    throw new DossierError("PRIVATE_UNAUTHORIZED", 401);
  return { ownerId: entry.ownerId, scopes: entry.scopes };
}
export async function authorizePrivateCode(
  env: PrivateAuthEnv,
  code: string,
  requested: readonly string[],
): Promise<PrivateContext> {
  const ctx = await resolve(env, "code", code);
  const scopes = requested.filter(
    (s) => s !== "mcp:read" && s !== "offline_access",
  );
  if (
    !scopes.length ||
    scopes.some((s) => !ctx.scopes.includes(scopeSchema.parse(s)))
  )
    throw new DossierError("PRIVATE_SCOPE_DENIED", 403);
  return { ...ctx, scopes: scopeSchema.array().parse(scopes) };
}
export async function authenticatePrivateBearer(
  request: Request,
  env: PrivateAuthEnv,
) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer "))
    throw new DossierError("PRIVATE_UNAUTHORIZED", 401);
  return resolve(env, "token", header.slice(7));
}
export function requirePrivateContext(
  value: unknown,
  scope: string,
): PrivateContext {
  const result = privateContextSchema.safeParse(value);
  if (!result.success || !result.data.scopes.includes(scopeSchema.parse(scope)))
    throw new DossierError("PRIVATE_SCOPE_DENIED", 403);
  return result.data;
}

export function assertPrivateOwnerActive(
  env: PrivateAuthEnv,
  context: PrivateContext,
  scope: string,
) {
  let entries: z.infer<typeof credentialSchema>[];
  try {
    entries = z
      .array(credentialSchema)
      .max(1000)
      .parse(JSON.parse(env.PRIVATE_CONNECTIONS ?? "[]"));
  } catch {
    throw new DossierError("PRIVATE_AUTH_UNCONFIGURED", 503);
  }
  if (
    !entries.some(
      (e) =>
        e.ownerId === context.ownerId &&
        e.scopes.includes(scopeSchema.parse(scope)) &&
        (!e.expiresAt || Date.parse(e.expiresAt) > Date.now()),
    )
  )
    throw new DossierError("PRIVATE_SCOPE_DENIED", 403);
}
