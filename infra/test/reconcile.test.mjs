import test from "node:test";
import assert from "node:assert/strict";
import manifest from "../production.json" with { type: "json" };
import { client, reconcile } from "../cloudflare.mjs";
import { ocrUnchanged, rollbackWorker, uploadWorker } from "../release.mjs";

test("a reconciled deployment issues no infrastructure mutations", async () => {
  const api = {
    call: () => {
      throw Error("unexpected mutation");
    },
    post: () => {
      throw Error("unexpected mutation");
    },
  };
  await reconcile(manifest, api, {
    metadataToCreate: [],
    consumerUpdate: false,
    scheduleUpdate: false,
  });
});
test("only missing Vectorize metadata indexes are added, never removed", async () => {
  const calls = [];
  await reconcile(
    manifest,
    { post: async (path, body) => calls.push({ path, body }) },
    {
      metadataToCreate: ["generation"],
      consumerUpdate: false,
      scheduleUpdate: false,
    },
  );
  assert.deepEqual(calls, [
    {
      path: "/vectorize/v2/indexes/secop-dossier-evidence/metadata_index/create",
      body: { propertyName: "generation", indexType: "string" },
    },
  ]);
});
test("OCR rebuild is skipped only when both sources and the live deployment/image match", () => {
  const inventory = {
    ocrDeployments: {
      deployments: [{ versions: [{ version_id: "current", percentage: 100 }] }],
    },
    ocrApp: { configuration: { image: "digest" } },
  };
  const checkpoint = {
    ocrSourceHash: "hash",
    ocrVersions: [{ version_id: "current", percentage: 100 }],
    ocrImage: "digest",
  };
  assert.equal(ocrUnchanged(checkpoint, "hash", inventory), true);
  assert.equal(ocrUnchanged(checkpoint, "changed", inventory), false);
  assert.equal(
    ocrUnchanged({ ...checkpoint, ocrImage: "other" }, "hash", inventory),
    false,
  );
  assert.equal(ocrUnchanged(null, "hash", inventory), false);
});
test("main upload retains all secret bindings and does not upload secret values", async () => {
  let posted;
  await uploadWorker(
    manifest,
    { call: async (path, init) => (posted = { path, init }) },
    { bindings: [] },
    new Uint8Array([1]),
  );
  const metadata = JSON.parse(posted.init.body.get("metadata"));
  assert.deepEqual(metadata.keep_bindings, ["secret_text"]);
  assert.equal(
    metadata.bindings.some((b) => b.type === "secret_text"),
    false,
  );
});
test("authentication and server errors are sanitized; failed writes are not blindly retried", async () => {
  let count = 0;
  const api = client("account", "sensitive-token", async () => {
    count++;
    return new Response("sensitive-provider-body", { status: 401 });
  });
  await assert.rejects(
    () => api.post("/private", {}),
    (error) =>
      error.message.includes("401") && !error.message.includes("sensitive"),
  );
  assert.equal(count, 1);
});
test("recovery refuses an incomplete deployment split", async () => {
  await assert.rejects(
    () => rollbackWorker(manifest, {}, [{ version_id: "id", percentage: 50 }]),
    /complete recovery/,
  );
});
