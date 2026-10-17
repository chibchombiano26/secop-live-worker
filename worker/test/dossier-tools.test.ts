import { describe, it, expect } from "vitest";
import { routeContract, privateApiRequest } from "../src/dossier/api";
describe("private service API boundaries", () => {
  it("denies missing credentials before reading private resources", async () => {
    const response = await privateApiRequest(
      new Request("https://secop.test/private/v1/dossier?id=CO1.REQ.1"),
      {},
    );
    expect(response.status).toBe(401);
  });
  it("requires authorization for the fixed plugin dispatch endpoint", async () => {
    const r = await privateApiRequest(
      new Request("https://secop.test/private/v1/dispatch", {
        method: "POST",
        body: JSON.stringify({
          operation: "prepare",
          arguments: { processId: "CO1.REQ.1", idempotencyKey: "12345678" },
        }),
      }),
      {},
    );
    expect(r.status).toBe(401);
  });
  it("keeps read routes read-only and mutations explicit POST operations", () => {
    expect(routeContract["prepare"].method).toBe("POST");
    expect(routeContract["chat"].method).toBe("POST");
    expect(routeContract["dossier"].method).toBe("GET");
    expect(routeContract["prepare"].scope).toBe("dossier:write");
    expect(routeContract["company"].scope).toBe("company:write");
    expect(routeContract["chat"].scope).toBe("conversation:write");
  });
  it("returns schema-derived API documentation without exposing configuration", async () => {
    const response = await privateApiRequest(
      new Request("https://secop.test/private/openapi.json"),
      {},
    );
    const doc: any = await response.json();
    expect(doc.paths["/private/v1/prepare"].post.requestBody).toBeDefined();
    expect(JSON.stringify(doc)).not.toContain("PRIVATE_AUTH_PEPPER");
  });
});
