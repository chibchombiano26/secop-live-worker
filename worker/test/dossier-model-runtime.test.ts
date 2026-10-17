import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";

async function runtime(redirect: boolean) {
  const output = await build({
    stdin: {
      contents: `import { ConfiguredModel } from './src/dossier/model';
      export default { async fetch() { try {
        return Response.json(await new ConfiguredModel({MODEL_NAME:'fixture',MODEL_URL:'https://provider.test/chat',MODEL_KEY:'private-fixture'}).generate({purpose:'chat',evidence:[],instructions:'Return JSON'}));
      } catch (e) { return Response.json({code:e.code}); } } };`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd"],
  });
  let calls = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: output.outputFiles[0].text,
      compatibilityDate: "2026-10-01",
      outboundService: async (request: Request) => {
        calls++;
        expect(request.url).toBe("https://provider.test/chat");
        expect(request.headers.get("Authorization")).toBe(
          "Bearer private-fixture",
        );
        return redirect
          ? new Response(null, {
              status: 302,
              headers: { Location: "https://untrusted.test/" },
            })
          : Response.json({
              choices: [
                {
                  message: { content: '{"answer":"ok"}' },
                  finish_reason: "stop",
                },
              ],
            });
      },
    }),
  );
  return { mf, calls: () => calls };
}
describe("model requests in the actual Workers runtime", () => {
  it("can send authenticated model requests using supported fetch options", async () => {
    const r = await runtime(false);
    try {
      expect(await (await r.mf.dispatchFetch("http://test/")).json()).toEqual({
        answer: "ok",
      });
      expect(r.calls()).toBe(1);
    } finally {
      await r.mf.dispose();
    }
  });
  it("rejects redirects without forwarding the model credential", async () => {
    const r = await runtime(true);
    try {
      expect(await (await r.mf.dispatchFetch("http://test/")).json()).toEqual({
        code: "MODEL_PROVIDER_HTTP_302",
      });
      expect(r.calls()).toBe(1);
    } finally {
      await r.mf.dispose();
    }
  });
});
