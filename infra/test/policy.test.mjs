import test from "node:test";
import assert from "node:assert/strict";
import manifest from "../production.json" with { type: "json" };
import {
  assertSafePlan,
  desiredBindings,
  assertBindings,
  vectorActions,
  assertOcr,
  workerMetadata,
} from "../policy.mjs";

test("adoption permits imports but rejects creation, replacement and deletion", () => {
  assert.doesNotThrow(() =>
    assertSafePlan({
      resource_changes: [
        {
          address: "database",
          change: { actions: ["no-op"] },
          importing: { id: "existing" },
        },
      ],
    }),
  );
  for (const actions of [
    ["delete"],
    ["delete", "create"],
    ["create"],
    ["update"],
  ])
    assert.throws(
      () =>
        assertSafePlan({
          resource_changes: [{ address: "database", change: { actions } }],
        }),
      /non-adoption/,
    );
});
test("all resource bindings retain their pinned identities", () => {
  const bindings = desiredBindings(manifest);
  assert.equal(
    bindings.find((b) => b.name === "DOSSIER_DB").id,
    manifest.database.id,
  );
  const live = [
    ...bindings,
    ...manifest.requiredSecrets.map((name) => ({ name, type: "secret_text" })),
  ];
  assert.doesNotThrow(() => assertBindings(manifest, live));
  assert.throws(
    () =>
      assertBindings(
        manifest,
        live.map((b) =>
          b.name === "OAUTH_KV" ? { ...b, namespace_id: "wrong" } : b,
        ),
      ),
    /OAUTH_KV/,
  );
  assert.throws(
    () =>
      assertBindings(
        manifest,
        live.filter((b) => b.name !== "PRIVATE_CONNECTIONS"),
      ),
    /PRIVATE_CONNECTIONS/,
  );
  assert.throws(
    () =>
      assertBindings(manifest, [
        ...live,
        { type: "kv_namespace", name: "UNKNOWN", namespace_id: "new" },
      ]),
    /unmanaged/,
  );
});
test("metadata reconciliation is idempotent and refuses incompatible indexes", () => {
  const index = { config: { dimensions: 1024, metric: "cosine" } };
  assert.deepEqual(
    vectorActions(manifest, index, [
      { propertyName: "ownerScope", indexType: "String" },
    ]),
    ["tenderScope", "generation"],
  );
  assert.deepEqual(
    vectorActions(
      manifest,
      index,
      Object.keys(manifest.vectorize.metadata).map((propertyName) => ({
        propertyName,
        indexType: "string",
      })),
    ),
    [],
  );
  assert.throws(
    () =>
      vectorActions(
        manifest,
        { config: { dimensions: 768, metric: "cosine" } },
        [],
      ),
    /incompatible/,
  );
  assert.throws(
    () =>
      vectorActions(manifest, index, [
        { propertyName: "ownerScope", indexType: "Number" },
      ]),
    /incompatible/,
  );
});
test("OCR cannot change its Durable Object identity or become public", () => {
  const settings = {
    bindings: [
      {
        name: "OCR_CONTAINER",
        type: "durable_object_namespace",
        namespace_id: manifest.ocr.namespaceId,
        class_name: manifest.ocr.className,
      },
    ],
  };
  const app = {
    id: manifest.ocr.applicationId,
    max_instances: 1,
    durable_objects: { namespace_id: manifest.ocr.namespaceId },
    configuration: { vcpu: 1, memory_mib: 6144, disk: { size_mb: 12000 } },
  };
  assert.doesNotThrow(() =>
    assertOcr(
      manifest,
      settings,
      { enabled: false, previews_enabled: false },
      app,
    ),
  );
  assert.throws(
    () => assertOcr(manifest, settings, { enabled: true }, app),
    /public/,
  );
  assert.throws(
    () =>
      assertOcr(
        manifest,
        settings,
        { enabled: false },
        { ...app, max_instances: 2 },
      ),
    /capacity/,
  );
  assert.throws(
    () => assertOcr(manifest, { bindings: [] }, { enabled: false }, app),
    /identity/,
  );
});
test("worker upload keeps secret values and operational metadata out of application configuration", () => {
  const settings = {
    bindings: [
      ...desiredBindings(manifest),
      { type: "secret_text", name: "PRIVATE_CONNECTIONS" },
    ],
    observability: { enabled: true },
    limits: { cpu_ms: 300000 },
    tags: ["existing"],
  };
  const metadata = workerMetadata(manifest, settings);
  assert.deepEqual(metadata.keep_bindings, ["secret_text"]);
  assert.equal(
    metadata.bindings.some((b) => b.type === "secret_text"),
    false,
  );
  assert.deepEqual(metadata.limits, settings.limits);
  assert.deepEqual(metadata.observability, settings.observability);
  assert.deepEqual(metadata.tags, settings.tags);
});

test("local OCR configuration cannot expose URLs or introduce a new Durable Object migration", async () => {
  const { assertOcrConfig } = await import("../policy.mjs");
  const config = {
    name: manifest.ocr.worker,
    main: "index.ts",
    workers_dev: false,
    preview_urls: false,
    containers: [
      {
        class_name: manifest.ocr.className,
        instance_type: "standard-2",
        max_instances: 1,
      },
    ],
    durable_objects: {
      bindings: [{ name: "OCR_CONTAINER", class_name: manifest.ocr.className }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: [manifest.ocr.className] }],
  };
  assert.doesNotThrow(() => assertOcrConfig(manifest, config));
  assert.throws(
    () => assertOcrConfig(manifest, { ...config, preview_urls: true }),
    /private/,
  );
  assert.throws(
    () =>
      assertOcrConfig(manifest, { ...config, routes: ["public.example/*"] }),
    /private/,
  );
  assert.throws(
    () =>
      assertOcrConfig(manifest, {
        ...config,
        migrations: [
          ...config.migrations,
          { tag: "v2", deleted_classes: [manifest.ocr.className] },
        ],
      }),
    /identity/,
  );
});

test("database recovery copies cannot be uploaded to a publicly accessible bucket", async () => {
  const { assertPrivateBucket } = await import("../policy.mjs");
  assert.doesNotThrow(() =>
    assertPrivateBucket({ enabled: false }, { domains: [] }),
  );
  assert.throws(
    () => assertPrivateBucket({ enabled: true }, { domains: [] }),
    /public/,
  );
  assert.throws(
    () =>
      assertPrivateBucket({ enabled: false }, { domains: [{ enabled: true }] }),
    /public/,
  );
  assert.throws(() => assertPrivateBucket({}, { domains: [] }), /public/);
});
test("Flue bindings preserve the owner of durable storage and workflow classes", () => {
  const m = {
    ...manifest,
    agent: {
      binding: "FLUE_TENDER_STUDY_AGENT",
      className: "FlueTenderStudyAgent",
      namespaceId: "pinned-agent",
      migrationTag: "secop-flue-v1",
    },
    workflow: {
      binding: "DOSSIER_WORKFLOW",
      name: "secop-dossier-processing",
      className: "SecopDossierWorkflow",
    },
  };
  const live = [
    ...desiredBindings(m),
    ...m.requiredSecrets.map((name) => ({ name, type: "secret_text" })),
  ];
  assert.equal(
    live.find((b) => b.name === m.agent.binding)?.class_name,
    m.agent.className,
  );
  assert.equal(
    live.find((b) => b.name === m.workflow.binding)?.workflow_name,
    m.workflow.name,
  );
  assert.throws(
    () =>
      assertBindings(
        m,
        live.map((b) =>
          b.name === m.agent.binding ? { ...b, namespace_id: "foreign" } : b,
        ),
      ),
    /FLUE_TENDER_STUDY_AGENT/,
  );
  assert.throws(
    () =>
      assertBindings(
        m,
        live.map((b) =>
          b.name === m.workflow.binding
            ? { ...b, class_name: "OtherWorkflow" }
            : b,
        ),
      ),
    /DOSSIER_WORKFLOW/,
  );
});
test("Flue migration is append-only and cannot recreate a deployed agent namespace", () => {
  const m = {
    ...manifest,
    agent: {
      binding: "FLUE_TENDER_STUDY_AGENT",
      className: "FlueTenderStudyAgent",
      migrationTag: "secop-flue-v1",
    },
  };
  assert.deepEqual(workerMetadata(m, {}).migrations, {
    new_tag: "secop-flue-v1",
    new_sqlite_classes: ["FlueTenderStudyAgent"],
  });
  assert.equal(
    workerMetadata(m, { migration_tag: "secop-flue-v1" }).migrations,
    undefined,
  );
  assert.throws(
    () => workerMetadata(m, { migration_tag: "unknown-migration" }),
    /migration/,
  );
});

test("pinned deployed agents never replay creation when settings omit migration tags", () => {
  assert.equal(
    workerMetadata(
      { ...manifest, agent: { ...manifest.agent, namespaceId: "existing" } },
      {},
    ).migrations,
    undefined,
  );
});

test("agent uploads resolve the owned class rather than forwarding a read-only namespace binding", () => {
  const metadata = workerMetadata(manifest, {});
  const binding = metadata.bindings.find(
    (b) => b.name === manifest.agent.binding,
  );
  assert.equal(binding.namespace_id, undefined);
  assert.equal(binding.class_name, manifest.agent.className);
});

test("agent code updates have a bounded deferred rollout", () => {
  assert.deepEqual(workerMetadata(manifest, {}).code_update_strategy, {
    mode: "deferred",
    max_delay: 30,
  });
});
