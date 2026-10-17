import { isDeepStrictEqual } from "node:util";

export function assertSafePlan(plan) {
  for (const resource of plan.resource_changes ?? []) {
    if (
      (resource.change?.actions ?? []).some(
        (action) => action !== "no-op" && action !== "read",
      )
    )
      throw new Error(
        `Blocked non-adoption change at ${resource.address}. Existing persistent resources must not be recreated or modified by deployment.`,
      );
  }
  if (plan.errored || plan.deferred_changes?.length)
    throw new Error("Incomplete infrastructure plan");
}

export function desiredBindings(m) {
  return [
    ...Object.entries(m.kv).map(([name, value]) => ({
      name,
      type: "kv_namespace",
      namespace_id: value.id,
    })),
    { name: "DOSSIER_DB", type: "d1", id: m.database.id },
    { name: "DOSSIER_FILES", type: "r2_bucket", bucket_name: m.bucket.name },
    { name: "DOSSIER_QUEUE", type: "queue", queue_name: m.queues.jobs.name },
    {
      name: "DOSSIER_VECTORS",
      type: "vectorize",
      index_name: m.vectorize.name,
    },
    {
      name: "SECOP_OCR",
      type: "service",
      service: m.ocr.worker,
      environment: "production",
    },
    { name: "AI", type: "ai" },
    ...(m.agent
      ? [
          {
            name: m.agent.binding,
            type: "durable_object_namespace",
            class_name: m.agent.className,
            ...(m.agent.namespaceId
              ? { namespace_id: m.agent.namespaceId }
              : {}),
          },
        ]
      : []),
    ...(m.workflow
      ? [
          {
            name: m.workflow.binding,
            type: "workflow",
            workflow_name: m.workflow.name,
            class_name: m.workflow.className,
          },
        ]
      : []),
    ...Object.entries(m.variables).map(([name, text]) => ({
      name,
      type: "plain_text",
      text,
    })),
  ];
}
function normalized(binding) {
  const b = { ...binding };
  if (b.type === "d1") {
    b.id = b.database_id ?? b.id;
    delete b.database_id;
  }
  delete b.project;
  return b;
}
export function assertBindings(
  m,
  bindings,
  { verifyValues = false, allowAgentBootstrap = false } = {},
) {
  if (new Set(bindings.map((b) => b.name)).size !== bindings.length)
    throw new Error("Duplicate live binding names");
  const wanted = desiredBindings(m);
  for (const expected of wanted) {
    const actual = bindings.find((b) => b.name === expected.name);
    if (
      !actual &&
      allowAgentBootstrap &&
      !m.agent?.namespaceId &&
      [m.agent?.binding, m.workflow?.binding].includes(expected.name)
    )
      continue;
    if (!actual && expected.type === "plain_text" && !verifyValues) continue;
    if (!actual || actual.type !== expected.type)
      throw new Error(`Missing or incompatible ${expected.name} binding`);
    if (expected.type === "plain_text" && !verifyValues) continue;
    if (expected.type === "durable_object_namespace") {
      if (
        actual.class_name !== expected.class_name ||
        (actual.script_name && actual.script_name !== m.worker) ||
        (expected.namespace_id && actual.namespace_id !== expected.namespace_id)
      )
        throw new Error(
          `Resource identity/configuration mismatch: ${expected.name}`,
        );
      continue;
    }
    if (expected.type === "workflow") {
      if (
        actual.workflow_name !== expected.workflow_name ||
        actual.class_name !== expected.class_name ||
        (actual.script_name && actual.script_name !== m.worker)
      )
        throw new Error(
          `Resource identity/configuration mismatch: ${expected.name}`,
        );
      continue;
    }
    if (!isDeepStrictEqual(normalized(actual), normalized(expected)))
      throw new Error(
        `Resource identity/configuration mismatch: ${expected.name}`,
      );
  }
  for (const name of m.requiredSecrets) {
    if (!bindings.some((b) => b.name === name && b.type === "secret_text"))
      throw new Error(`Required secret missing: ${name}`);
  }
  for (const b of bindings) {
    if (b.type !== "secret_text" && !wanted.some((w) => w.name === b.name))
      throw new Error(`Refusing to remove unmanaged binding ${b.name}`);
  }
}
export function vectorActions(m, index, metadata) {
  if (
    index?.config?.dimensions !== m.vectorize.dimensions ||
    index?.config?.metric !== m.vectorize.metric
  )
    throw new Error(
      "Existing Vectorize index is incompatible; replacement is forbidden",
    );
  return Object.entries(m.vectorize.metadata).flatMap(([name, type]) => {
    const existing = metadata.find((i) => i.propertyName === name);
    if (existing && existing.indexType?.toLowerCase() !== type)
      throw new Error(
        `Vectorize metadata ${name} is incompatible; deletion is forbidden`,
      );
    return existing ? [] : [name];
  });
}
export function assertOcr(m, settings, subdomain, app) {
  if (subdomain.enabled || subdomain.previews_enabled)
    throw new Error("OCR must not be public");
  const binding = settings.bindings?.find((b) => b.name === "OCR_CONTAINER");
  if (
    binding?.namespace_id !== m.ocr.namespaceId ||
    binding?.class_name !== m.ocr.className ||
    app?.id !== m.ocr.applicationId ||
    app.durable_objects?.namespace_id !== m.ocr.namespaceId
  )
    throw new Error("OCR Durable Object/application identity changed");
  if (
    app.max_instances !== m.ocr.maxInstances ||
    app.configuration?.vcpu !== 1 ||
    app.configuration?.memory_mib !== 6144 ||
    app.configuration?.disk?.size_mb !== 12000
  )
    throw new Error(
      "OCR capacity differs from the pinned standard-2 single-instance deployment",
    );
}
export function workerMetadata(m, settings) {
  const metadata = {
    main_module: "bundle.js",
    bindings: desiredBindings(m).map((binding) => {
      if (binding.type !== "durable_object_namespace") return binding;
      const { namespace_id, ...ownedClass } = binding;
      return ownedClass;
    }),
    keep_bindings: ["secret_text"],
    compatibility_date: m.compatibilityDate,
    compatibility_flags: m.compatibilityFlags,
  };
  if (m.agent) {
    if (
      settings.migration_tag &&
      settings.migration_tag !== m.agent.migrationTag
    )
      throw new Error(
        "Unexpected agent migration tag; refusing namespace recreation",
      );
    if (!settings.migration_tag && !m.agent.namespaceId)
      metadata.migrations = {
        new_tag: m.agent.migrationTag,
        new_sqlite_classes: [m.agent.className],
      };
  }
  for (const key of [
    "usage_model",
    "tags",
    "tail_consumers",
    "logpush",
    "observability",
    "limits",
    "placement",
  ]) {
    if (settings[key] !== undefined) metadata[key] = settings[key];
  }
  return metadata;
}

export function assertOcrConfig(m, config) {
  if (
    config.workers_dev !== false ||
    config.preview_urls !== false ||
    config.route ||
    config.routes?.length
  )
    throw new Error("OCR configuration must remain private");
  const container = config.containers?.[0];
  if (
    config.name !== m.ocr.worker ||
    config.main !== "index.ts" ||
    config.containers?.length !== 1 ||
    container?.class_name !== m.ocr.className ||
    container.instance_type !== m.ocr.instanceType ||
    container.max_instances !== m.ocr.maxInstances
  )
    throw new Error("OCR configuration changes its pinned service/capacity");
  if (
    !isDeepStrictEqual(config.durable_objects?.bindings, [
      { name: "OCR_CONTAINER", class_name: m.ocr.className },
    ]) ||
    !isDeepStrictEqual(config.migrations, [
      { tag: "v1", new_sqlite_classes: [m.ocr.className] },
    ])
  )
    throw new Error(
      "OCR Durable Object bindings/migrations must preserve the existing identity",
    );
}

export function assertPrivateBucket(managed, custom) {
  if (
    managed.enabled !== false ||
    !Array.isArray(custom.domains) ||
    custom.domains.some((domain) => domain.enabled !== false)
  )
    throw new Error(
      "Recovery bucket must have no public r2.dev or enabled custom-domain access",
    );
}
