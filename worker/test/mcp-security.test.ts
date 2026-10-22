import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHandler } from "../src/mcp";
import type { Env } from "../src/socrata";

afterEach(() => vi.restoreAllMocks());

function connectClient(handler: ReturnType<typeof createHandler>) {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://secop.test/mcp"),
    {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    },
  );
  const client = new Client({ name: "mcp-security-test", version: "1.0.0" });
  return { client, connect: () => client.connect(transport) };
}

describe("MCP request security bounds", () => {
  it("rejects tool arguments above the configured element limit before tool execution", async () => {
    const handler = createHandler({} as Env);
    const { client, connect } = connectClient(handler);
    await connect();
    try {
      const input = Object.fromEntries(
        Array.from({ length: 16_001 }, (_, index) => [`field-${index}`, index]),
      );
      const result = await client.callTool({
        name: "consultar_expediente",
        arguments: { input },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("maximum of 16000 elements");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SCOPE_DENIED");
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("allows the largest bounded company profile shape under the element cap", async () => {
    const handler = createHandler({} as Env);
    const { client, connect } = connectClient(handler);
    await connect();
    try {
      const facts = Array.from({ length: 200 }, (_, factIndex) => ({
        field: `field-${factIndex}`,
        value: factIndex,
        unit: "unit",
        period: null,
        reviewed: false,
        citations: Array.from({ length: 10 }, (_, citationIndex) => ({
          documentVersionId: `document-${citationIndex}`,
          page: citationIndex + 1,
          section: "section",
          excerpt: "evidence",
        })),
      }));
      const result = await client.callTool({
        name: "guardar_perfil_empresa",
        arguments: {
          input: {
            expectedRevision: 0,
            profile: { name: "Company", facts },
          },
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("PRIVATE_SCOPE_DENIED");
      expect(JSON.stringify(result)).not.toContain("maximum of 16000 elements");
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("keeps concurrent same-id tool responses attached to their callers", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        const soql = new URL(String(input)).searchParams.get("$query") ?? "";
        const processId = soql.match(/id_del_proceso = '([^']+)'/)?.[1];
        return Response.json(processId ? [{ id_del_proceso: processId }] : []);
      },
    );
    const handler = createHandler({ SOCRATA_DOMAIN: "secop.test" } as Env);
    const first = connectClient(handler);
    const second = connectClient(handler);
    await Promise.all([first.connect(), second.connect()]);

    try {
      const processIds = ["CO1.REQ.101", "CO1.REQ.202"];
      const [left, right] = await Promise.all(
        [first.client, second.client].map((client, index) =>
          client.callTool({
            name: "detalle_licitacion",
            arguments: { id_del_proceso: processIds[index] },
          }),
        ),
      );
      const returnedIds = [left, right].map((result) => {
        const content = result.content.find((item) => item.type === "text");
        return JSON.parse(content?.type === "text" ? content.text : "{}").id_del_proceso;
      });

      expect(returnedIds).toEqual(processIds);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.all([first.client.close(), second.client.close()]);
      await handler.close();
    }
  });
});
