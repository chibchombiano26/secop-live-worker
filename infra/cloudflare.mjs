import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertBindings,
  assertOcr,
  vectorActions,
  assertPrivateBucket,
  workflowSubrequestLimitUpdate,
} from "./policy.mjs";

export async function credentials(env = process.env) {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  const path =
    env.WRANGLER_AUTH_FILE ??
    (process.platform === "darwin"
      ? join(homedir(), "Library/Preferences/.wrangler/config/default.toml")
      : join(homedir(), ".config/.wrangler/config/default.toml"));
  const text = await readFile(path, "utf8").catch(() => "");
  const token = text.match(/^oauth_token\s*=\s*"([^\"]+)"/m)?.[1];
  if (!token)
    throw new Error(
      "Set CLOUDFLARE_API_TOKEN or sign in with Wrangler. Never put tokens in the inventory.",
    );
  return token;
}
export function client(accountId, token, fetcher = fetch) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  async function raw(path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(base + path, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
        signal: AbortSignal.timeout(60000),
      });
      if (
        (response.status === 429 || response.status >= 500) &&
        (!init.method || init.method === "GET") &&
        attempt < 2
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (attempt + 1)),
        );
        continue;
      }
      if (!response.ok)
        throw new Error(
          `Cloudflare ${init.method ?? "GET"} ${path.split("?")[0]} returned ${response.status}. No response body was logged.`,
        );
      return response;
    }
  }
  async function call(path, init = {}) {
    const result = await (await raw(path, init)).json();
    if (!result.success)
      throw new Error(`Cloudflare operation failed: ${path.split("?")[0]}`);
    return result.result;
  }
  return {
    raw,
    call,
    post: (path, body) =>
      call(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}
export async function inspect(
  m,
  api,
  { verifyValues = false, allowAgentBootstrap = false } = {},
) {
  const base = `/workers/scripts/${m.worker}`;
  const [
    settings,
    kv,
    database,
    bucket,
    queues,
    index,
    metadata,
    ocrSettings,
    ocrSubdomain,
    ocrApp,
    deployments,
    ocrDeployments,
    schedules,
    subdomain,
    bucketManagedDomain,
    bucketCustomDomains,
  ] = await Promise.all([
    api.call(base + "/settings"),
    Promise.all(
      Object.values(m.kv).map((v) =>
        api.call(`/storage/kv/namespaces/${v.id}`),
      ),
    ),
    api.call(`/d1/database/${m.database.id}`),
    api.call(`/r2/buckets/${m.bucket.name}`),
    Promise.all(
      Object.values(m.queues).map((v) => api.call(`/queues/${v.id}`)),
    ),
    api.call(`/vectorize/v2/indexes/${m.vectorize.name}`),
    api.call(`/vectorize/v2/indexes/${m.vectorize.name}/metadata_index/list`),
    api.call(`/workers/scripts/${m.ocr.worker}/settings`),
    api.call(`/workers/scripts/${m.ocr.worker}/subdomain`),
    api.call(`/containers/applications/${m.ocr.applicationId}`),
    api.call(base + "/deployments"),
    api.call(`/workers/scripts/${m.ocr.worker}/deployments`),
    api.call(base + "/schedules"),
    api.call(base + "/subdomain"),
    api.call(`/r2/buckets/${m.bucket.name}/domains/managed`),
    api.call(`/r2/buckets/${m.bucket.name}/domains/custom`),
  ]);
  const service = await api.call(`/workers/services/${m.worker}`);
  settings.migration_tag = service.default_environment?.script?.migration_tag;
  if (m.agent?.namespaceId && settings.migration_tag !== m.agent.migrationTag)
    throw new Error("Agent migration tag mismatch");
  assertPrivateBucket(bucketManagedDomain, bucketCustomDomains);
  assertBindings(m, settings.bindings, { verifyValues, allowAgentBootstrap });
  if (
    verifyValues &&
    (settings.compatibility_date !== m.compatibilityDate ||
      JSON.stringify([...(settings.compatibility_flags ?? [])].sort()) !==
        JSON.stringify([...m.compatibilityFlags].sort()))
  )
    throw new Error("Worker compatibility configuration drift detected");
  const workflowSubrequestLimitUpdateDetected =
    workflowSubrequestLimitUpdate(m, settings);
  if (verifyValues && workflowSubrequestLimitUpdateDetected)
    throw new Error("Workflow subrequest limit drift detected");
  for (const v of Object.values(m.kv))
    if (!kv.some((k) => k.id === v.id && k.title === v.title))
      throw new Error("KV identity mismatch");
  if (
    database.uuid !== m.database.id ||
    database.name !== m.database.name ||
    bucket.name !== m.bucket.name
  )
    throw new Error("Persistent resource identity mismatch");
  for (const v of Object.values(m.queues))
    if (!queues.some((q) => q.queue_id === v.id && q.queue_name === v.name))
      throw new Error("Queue identity mismatch");
  const consumer = queues
    .find((q) => q.queue_id === m.queues.jobs.id)
    ?.consumers?.find((c) => c.consumer_id === m.consumer.id);
  if (
    !consumer ||
    (consumer.script ?? consumer.script_name) !== m.worker ||
    consumer.dead_letter_queue !== m.queues.dead.name
  )
    throw new Error("Consumer identity mismatch");
  assertOcr(m, ocrSettings, ocrSubdomain, ocrApp);
  if (!subdomain.enabled)
    throw new Error("Existing public SECOP endpoint is disabled");
  const metadataToCreate = vectorActions(
    m,
    index,
    metadata.metadataIndexes ?? [],
  );
  const scheduleUpdate =
    JSON.stringify((schedules.schedules ?? []).map((s) => s.cron).sort()) !==
    JSON.stringify([...m.crons].sort());
  const consumerUpdate = Object.entries(m.consumer.settings).some(
    ([k, v]) => consumer.settings?.[k] !== v,
  );
  return {
    settings,
    kv,
    database,
    bucket,
    queues,
    index,
    metadata,
    ocrSettings,
    ocrSubdomain,
    ocrApp,
    deployments,
    ocrDeployments,
    schedules,
    subdomain,
    metadataToCreate,
    workflowSubrequestLimitUpdate: workflowSubrequestLimitUpdateDetected,
    consumerUpdate,
    scheduleUpdate,
    bucketManagedDomain,
    bucketCustomDomains,
  };
}
export async function reconcile(m, api, inventory) {
  if (inventory.scheduleUpdate)
    await api.call(`/workers/scripts/${m.worker}/schedules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(m.crons.map((cron) => ({ cron }))),
    });
  for (const name of inventory.metadataToCreate)
    await api.post(
      `/vectorize/v2/indexes/${m.vectorize.name}/metadata_index/create`,
      { propertyName: name, indexType: m.vectorize.metadata[name] },
    );
  if (inventory.consumerUpdate)
    await api.call(`/queues/${m.queues.jobs.id}/consumers/${m.consumer.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "worker",
        script_name: m.worker,
        dead_letter_queue: m.queues.dead.name,
        settings: m.consumer.settings,
      }),
    });
}
export async function recordCounts(m, api) {
  const result = await api.post(`/d1/database/${m.database.id}/query`, {
    sql: "SELECT kind, COUNT(*) AS count FROM dossier_records GROUP BY kind ORDER BY kind",
  });
  return Object.fromEntries(
    result[0].results.map((row) => [row.kind, row.count]),
  );
}
export async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
export async function backup(m, api, dir, inventory) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await privateJson(join(dir, "inventory.json"), inventory);
  for (const name of [m.worker, m.ocr.worker]) {
    const response = await api.raw(`/workers/scripts/${name}`);
    await writeFile(
      join(dir, `${name}.multipart`),
      new Uint8Array(await response.arrayBuffer()),
      { mode: 0o600 },
    );
    await privateJson(join(dir, `${name}.content-type.json`), {
      contentType: response.headers.get("content-type"),
    });
  }
}
