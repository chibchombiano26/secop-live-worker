import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: fileURLToPath(new URL("./dist/bundle.js", import.meta.url)),
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    durableObjects: {
      FLUE_TENDER_STUDY_AGENT: {
        className: "FlueTenderStudyAgent",
        useSQLite: true,
      },
    },
    workflows: {
      DOSSIER_WORKFLOW: {
        name: "secop-dossier-processing",
        className: "SecopDossierWorkflow",
      },
    },
    bindings: { API_KEYS: "build-test-key" },
  }),
);
try {
  assert.equal(
    (await mf.dispatchFetch("https://secop.invalid/health")).status,
    200,
  );
  const metadata = await mf.dispatchFetch(
    "https://secop.invalid/.well-known/oauth-authorization-server",
  );
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.text()).includes("build-test-key"), false);
  assert.equal(
    (await mf.dispatchFetch("https://secop.invalid/agents/tender/foreign"))
      .status,
    401,
  );
  assert.equal(
    (
      await mf.dispatchFetch("https://secop.invalid/agents/tender/foreign", {
        headers: { "x-api-key": "build-test-key" },
      })
    ).status,
    404,
  );
  console.log(
    "Built Worker: health/OAuth preserved, agent routes denied, secrets absent from metadata.",
  );
} finally {
  await mf.dispose();
}
