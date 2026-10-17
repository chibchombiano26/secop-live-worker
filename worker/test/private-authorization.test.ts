import { describe, it, expect } from "vitest";
import {
  credentialDigest,
  authenticatePrivateBearer,
  authorizePrivateCode,
  requirePrivateContext,
} from "../src/dossier/authorization";
const scopes = [
  "dossier:read",
  "dossier:write",
  "company:write",
  "conversation:write",
];
async function setup() {
  const pepper = "x".repeat(40);
  return {
    PRIVATE_AUTH_PEPPER: pepper,
    PRIVATE_CONNECTIONS: JSON.stringify([
      {
        ownerId: "workspace-a",
        codeDigest: await credentialDigest(pepper, "code", "access-a"),
        tokenDigest: await credentialDigest(pepper, "token", "token-a"),
        scopes,
      },
      {
        ownerId: "workspace-b",
        codeDigest: await credentialDigest(pepper, "code", "access-b"),
        tokenDigest: await credentialDigest(pepper, "token", "token-b"),
        scopes,
      },
    ]),
  };
}
describe("private connection authorization", () => {
  it("rejects existing shared grants and caller-forged identity", () => {
    expect(() => requirePrivateContext({}, "dossier:read")).toThrow();
    expect(() =>
      requirePrivateContext(
        { ownerId: "a", scopes: ["mcp:read"] },
        "dossier:write",
      ),
    ).toThrow();
  });
  it("keeps stable owners on reconnect and separates connections", async () => {
    const env = await setup();
    expect((await authorizePrivateCode(env, "access-a", scopes)).ownerId).toBe(
      "workspace-a",
    );
    expect((await authorizePrivateCode(env, "access-a", scopes)).ownerId).toBe(
      "workspace-a",
    );
    expect((await authorizePrivateCode(env, "access-b", scopes)).ownerId).toBe(
      "workspace-b",
    );
  });
  it("allows only issued scopes", async () => {
    const env = await setup();
    await expect(
      authorizePrivateCode(env, "access-a", ["admin"]),
    ).rejects.toThrow();
  });
  it("verifies separate REST credentials and denies public keys, revoked tokens and absent configuration", async () => {
    const env = await setup();
    const request = (key: string) =>
      new Request("https://secop.test/private/v1", {
        headers: { Authorization: `Bearer ${key}` },
      });
    expect(
      (await authenticatePrivateBearer(request("token-a"), env)).ownerId,
    ).toBe("workspace-a");
    await expect(
      authenticatePrivateBearer(request("access-a"), env),
    ).rejects.toThrow();
    await expect(
      authenticatePrivateBearer(request("token-a"), {
        ...env,
        PRIVATE_CONNECTIONS: "[]",
      }),
    ).rejects.toThrow();
    await expect(
      authenticatePrivateBearer(request("token-a"), {}),
    ).rejects.toThrow();
  });
  it("denies expired credentials and scope escalation", async () => {
    const env = await setup();
    const entries = JSON.parse(env.PRIVATE_CONNECTIONS);
    entries[0].expiresAt = "2000-01-01T00:00:00Z";
    await expect(
      authorizePrivateCode(
        { ...env, PRIVATE_CONNECTIONS: JSON.stringify(entries) },
        "access-a",
        scopes,
      ),
    ).rejects.toThrow();
    expect(() =>
      requirePrivateContext(
        { ownerId: "a", scopes: ["dossier:read"] },
        "company:write",
      ),
    ).toThrow();
  });
});
