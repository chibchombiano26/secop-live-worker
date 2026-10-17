import { describe, expect, it, vi } from "vitest";
import { discoverInventory } from "../src/dossier/inventory";
import { downloadOfficialDocument } from "../src/dossier/downloads";
const url =
  "https://community.secop.gov.co/Public/Archive/RetrieveFile/Index?DocumentId=123";
const item = (id: string) => ({
  sourceId: id,
  name: `${id}.pdf`,
  url,
  processId: "CO1.REQ.1",
});
describe("complete inventories", () => {
  it("reads every page twice and deduplicates verified source identities", async () => {
    const page = vi.fn(async (_id: string, cursor: number) => ({
      items: [item(String(cursor))],
      nextCursor: cursor < 2 ? cursor + 1 : null,
    }));
    expect(await discoverInventory("CO1.REQ.1", page)).toHaveLength(3);
    expect(page).toHaveBeenCalledTimes(6);
  });
  it("rejects looping cursors, changing inventories and wrong process association", async () => {
    await expect(
      discoverInventory("CO1.REQ.1", async () => ({
        items: [item("1")],
        nextCursor: 0,
      })),
    ).rejects.toThrow("INVENTORY_UNSTABLE");
    let round = 0;
    await expect(
      discoverInventory("CO1.REQ.1", async () => ({
        items: [item(String(round++))],
        nextCursor: null,
      })),
    ).rejects.toThrow("INVENTORY_UNSTABLE");
    await expect(
      discoverInventory("CO1.REQ.1", async () => ({
        items: [{ ...item("1"), processId: "CO1.REQ.2" }],
        nextCursor: null,
      })),
    ).rejects.toThrow("ASSOCIATION_UNVERIFIED");
  });
});
describe("official downloads", () => {
  it("accepts real PDF bytes and computes a stable content hash", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("%PDF-1.7 evidence", {
          headers: { "content-type": "application/pdf" },
        }),
    );
    const a = await downloadOfficialDocument(url, { fetcher });
    expect(a.mime).toBe("application/pdf");
    expect(a.hash).toHaveLength(64);
    expect((await downloadOfficialDocument(url, { fetcher })).hash).toBe(
      a.hash,
    );
  });
  it("blocks nonofficial targets and each unsafe redirect", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/file" },
        }),
    );
    await expect(
      downloadOfficialDocument("http://127.0.0.1/x", { fetcher }),
    ).rejects.toThrow("UNSAFE_DOWNLOAD");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(downloadOfficialDocument(url, { fetcher })).rejects.toThrow(
      "UNSAFE_DOWNLOAD",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports captcha, overlimit, unsupported and network timeout separately", async () => {
    await expect(
      downloadOfficialDocument(url, {
        fetcher: async () =>
          new Response("<html>captcha</html>", {
            headers: { "content-type": "text/html" },
          }),
      }),
    ).rejects.toThrow("HUMAN_HELP_REQUIRED");
    await expect(
      downloadOfficialDocument(url, {
        maxBytes: 2,
        fetcher: async () => new Response("%PDF-long"),
      }),
    ).rejects.toThrow("DOCUMENT_TOO_LARGE");
    await expect(
      downloadOfficialDocument(url, {
        fetcher: async () => new Response("not a PDF"),
      }),
    ).rejects.toThrow("UNSUPPORTED_DOCUMENT");
    await expect(
      downloadOfficialDocument(url, {
        fetcher: async () => {
          throw new DOMException("timeout", "TimeoutError");
        },
      }),
    ).rejects.toThrow("DOWNLOAD_UNAVAILABLE");
  });
});
