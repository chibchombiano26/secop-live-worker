#!/usr/bin/env node
import { mkdir, readFile, open, unlink, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import manifest from "./production.json" with { type: "json" };
import {
  credentials,
  client,
  inspect,
  reconcile,
  backup,
  recordCounts,
  privateJson,
} from "./cloudflare.mjs";
import { assertSafePlan, assertOcrConfig } from "./policy.mjs";
import {
  ocrBuildCache,
  sourceHash,
  ocrUnchanged,
  deploymentVersions,
  uploadWorker,
  rollbackWorker,
} from "./release.mjs";

process.umask(0o077);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const state = join(root, "infra/.state");
const command = process.argv[2] ?? "plan";
function desiredVariableChanges(bindings) {
  return Object.entries(manifest.variables)
    .filter(
      ([name, value]) => bindings.find((b) => b.name === name)?.text !== value,
    )
    .map(([name]) => name);
}
if (!["plan", "deploy", "check"].includes(command))
  throw new Error("Usage: node infra/run.mjs plan|deploy|check");
await mkdir(state, { recursive: true, mode: 0o700 });
const lock = await open(join(state, "deployment.lock"), "wx", 0o600).catch(
  () => {
    throw new Error(
      "Another SECOP infrastructure command is running. Inspect the lock before removing it.",
    );
  },
);
let runDirectory;
try {
  const token = await credentials();
  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: manifest.accountId,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  };
  const api = client(manifest.accountId, token);
  const started = Date.now();
  const runId = new Date().toISOString().replaceAll(":", "-");
  runDirectory = join(resolve(process.env.SECOP_RECOVERY_DIR ?? state), runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  async function run(binary, args, label, { capture = false } = {}) {
    console.log(label);
    const out = await open(
      join(runDirectory, label.replaceAll(/[^a-z0-9]/gi, "_") + ".log"),
      "w",
      0o600,
    );
    let writes = Promise.resolve();
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: root,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let data = "";
        child.stdout.on("data", (chunk) => {
          writes = writes.then(() => out.write(chunk));
          if (capture) data += chunk;
        });
        child.stderr.on("data", (chunk) => {
          writes = writes.then(() => out.write(chunk));
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(data)
            : reject(
                new Error(
                  `${label} failed (${code}). Inspect the private recovery logs.`,
                ),
              ),
        );
      });
      return result;
    } finally {
      await writes;
      await out.close();
    }
  }
  console.log(
    "Verifying existing SECOP resource identities and private OCR configuration.",
  );
  const ocrConfig = JSON.parse(
    (await readFile(join(root, "ocr/wrangler.jsonc"), "utf8")).replace(
      /,\s*([}\]])/g,
      "$1",
    ),
  );
  assertOcrConfig(manifest, ocrConfig);
  const before = await inspect(manifest, api, {
    verifyValues: command === "check",
    allowAgentBootstrap: command !== "check",
  });
  const countsBefore = await recordCounts(manifest, api);
  if (command === "check") {
    if (
      before.metadataToCreate.length ||
      before.consumerUpdate ||
      before.scheduleUpdate
    )
      throw new Error("Infrastructure configuration drift detected");
    console.log(
      JSON.stringify({
        verified: true,
        records: countsBefore,
        vectorize: manifest.vectorize.name,
        ocrPrivate: true,
      }),
    );
  } else {
    const tofu = process.env.TOFU_BIN ?? "tofu";
    await run(
      tofu,
      ["-chdir=tofu/live", "init", "-input=false"],
      "Initialize OpenTofu",
    );
    await run(
      tofu,
      [
        "-chdir=tofu/live",
        "plan",
        "-input=false",
        "-out=" + join(runDirectory, "adoption.tfplan"),
      ],
      "Plan existing resource adoption",
    );
    const plan = JSON.parse(
      await run(
        tofu,
        [
          "-chdir=tofu/live",
          "show",
          "-json",
          join(runDirectory, "adoption.tfplan"),
        ],
        "Validate adoption plan",
        { capture: true },
      ),
    );
    assertSafePlan(plan);
    const changes = {
      imported: (plan.resource_changes ?? []).filter(
        (r) => r.change?.importing || r.importing,
      ).length,
      storageChanges: 0,
      workerVariablesToUpdate: desiredVariableChanges(before.settings.bindings),
      metadataToCreate: before.metadataToCreate,
      consumerUpdate: before.consumerUpdate,
      scheduleUpdate: before.scheduleUpdate,
    };
    await privateJson(join(runDirectory, "plan-summary.json"), changes);
    console.log(JSON.stringify(changes));
    if (command === "deploy") {
      // Every mutation follows identity checks and a no-replacement adoption plan.
      await backup(manifest, api, runDirectory, before);
      await privateJson(
        join(runDirectory, "record-counts-before.json"),
        countsBefore,
      );
      const config = {
        name: manifest.worker,
        account_id: manifest.accountId,
        main: "dist/bundle.js",
        compatibility_date: manifest.compatibilityDate,
        d1_databases: [
          {
            binding: "DOSSIER_DB",
            database_id: manifest.database.id,
            database_name: manifest.database.name,
            migrations_dir: "migrations",
          },
        ],
      };
      const configPath = join(root, "worker/.wrangler.production.json");
      await privateJson(configPath, config);
      const wrangler = join(root, "worker/node_modules/.bin/wrangler");
      const databaseBackup = join(runDirectory, "database.sql");
      await run(
        wrangler,
        [
          "d1",
          "export",
          "DOSSIER_DB",
          "--remote",
          "--config",
          configPath,
          "--output",
          databaseBackup,
        ],
        "Back up existing D1 data",
      );
      await chmod(databaseBackup, 0o600);
      // Persist recovery artifacts inside the already private dossier bucket, never public artifacts.
      for (const name of [
        "database.sql",
        "inventory.json",
        `${manifest.worker}.multipart`,
        `${manifest.worker}.content-type.json`,
        `${manifest.ocr.worker}.multipart`,
        `${manifest.ocr.worker}.content-type.json`,
      ])
        await run(
          wrangler,
          [
            "r2",
            "object",
            "put",
            `${manifest.bucket.name}/ops/deployments/${runId}/${name}`,
            "--remote",
            "--file",
            join(runDirectory, name),
          ],
          `Persist recovery ${name}`,
        );
      await run(
        tofu,
        [
          "-chdir=tofu/live",
          "apply",
          "-input=false",
          join(runDirectory, "adoption.tfplan"),
        ],
        "Adopt existing protected resources",
      );
      await reconcile(manifest, api, before);
      const previous = JSON.parse(
        await readFile(join(state, "ocr-build-cache.json"), "utf8").catch(() =>
          readFile(join(state, "last-release.json"), "utf8").catch(
            () => "null",
          ),
        ),
      );
      const checkpoint = previous ?? manifest.ocr.verifiedBuild;
      const hash = await sourceHash(root);
      const skipOcr = ocrUnchanged(checkpoint, hash, before);
      await run(
        "npm",
        ["--prefix", "worker", "run", "bundle"],
        "Build SECOP worker",
      );
      if (!skipOcr)
        await run(
          wrangler,
          ["deploy", "--config", "ocr/wrangler.jsonc"],
          "Deploy existing private OCR service",
        );
      else
        console.log(
          "OCR source and live deployment match the verified checkpoint; skipping container rebuild.",
        );
      // Re-read to detect changes to secrets/bindings made during a slow container build.
      const preUpload = await inspect(manifest, api, {
        allowAgentBootstrap: true,
      });
      if (
        JSON.stringify(deploymentVersions(before.deployments)) !==
        JSON.stringify(deploymentVersions(preUpload.deployments))
      )
        throw new Error(
          "SECOP changed during deployment. Restart after reviewing concurrent changes.",
        );
      let uploaded = false;
      let uploadedVersions;
      try {
        await uploadWorker(
          manifest,
          api,
          preUpload.settings,
          await readFile(join(root, "worker/dist/bundle.js")),
        );
        uploaded = true;
        if (manifest.workflow)
          await api.call(`/workflows/${manifest.workflow.name}`, {
            method: "PUT",
            body: JSON.stringify({
              script_name: manifest.worker,
              class_name: manifest.workflow.className,
            }),
            headers: { "Content-Type": "application/json" },
          });
        uploadedVersions = deploymentVersions(
          await api.call(`/workers/scripts/${manifest.worker}/deployments`),
        );
        const after = await inspect(manifest, api, { verifyValues: true });
        if (
          after.metadataToCreate.length ||
          after.consumerUpdate ||
          after.scheduleUpdate
        )
          throw new Error("Post-deployment reconciliation incomplete");
        const countsAfter = await recordCounts(manifest, api);
        for (const [kind, count] of Object.entries(countsBefore))
          if ((countsAfter[kind] ?? 0) < count)
            throw new Error(
              `Record count decreased for ${kind}; manual investigation required`,
            );
        const health = await fetch(manifest.url + "/health", {
          signal: AbortSignal.timeout(30000),
        });
        if (!health.ok) throw new Error("Public SECOP health failed");
        const privateUnauthenticated = await fetch(
          manifest.url + "/private/v1/dispatch",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"operation":"companies"}',
            signal: AbortSignal.timeout(30000),
          },
        );
        if (![401, 403].includes(privateUnauthenticated.status))
          throw new Error("Private SECOP authentication boundary failed");
        const release = {
          runId,
          verifiedAt: new Date().toISOString(),
          ocrSourceHash: hash,
          ocrVersions: deploymentVersions(after.ocrDeployments),
          ocrImage: after.ocrApp.configuration.image,
          workerVersions: deploymentVersions(after.deployments),
          recordsBefore: countsBefore,
          recordsAfter: countsAfter,
          seconds: Math.round((Date.now() - started) / 1000),
        };
        await privateJson(join(state, "last-release.json"), release);
        await privateJson(
          join(state, "ocr-build-cache.json"),
          ocrBuildCache(release),
        );
        await privateJson(join(runDirectory, "verified-release.json"), release);
        await run(
          wrangler,
          [
            "r2",
            "object",
            "put",
            `${manifest.bucket.name}/ops/deployments/${runId}/verified-release.json`,
            "--remote",
            "--file",
            join(runDirectory, "verified-release.json"),
          ],
          "Persist verified release receipt",
        );
        console.log(
          JSON.stringify({
            deployed: true,
            ocrRebuilt: !skipOcr,
            recordsBefore: countsBefore,
            recordsAfter: countsAfter,
            seconds: release.seconds,
            recovery: runDirectory,
          }),
        );
      } catch (error) {
        if (uploaded) {
          const current = deploymentVersions(
            await api.call(`/workers/scripts/${manifest.worker}/deployments`),
          );
          if (
            !uploadedVersions ||
            JSON.stringify(current) !== JSON.stringify(uploadedVersions)
          )
            throw new Error(
              "Deployment failed and concurrent/uncertain state prevents automatic rollback. Inspect the recovery directory.",
              { cause: error },
            );
          await rollbackWorker(
            manifest,
            api,
            deploymentVersions(before.deployments),
          );
          console.error(
            "Restored the previous SECOP Worker deployment. Storage and OCR artifacts remain intact; inspect the recovery directory.",
          );
        }
        throw error;
      }
    }
  }
} finally {
  await lock.close();
  await unlink(join(state, "deployment.lock"));
}
