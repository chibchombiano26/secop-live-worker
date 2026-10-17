import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { workerMetadata } from "./policy.mjs";

export function deploymentVersions(deployment) {
  return deployment.deployments?.[0]?.versions ?? [];
}
export async function sourceHash(root) {
  const hash = createHash("sha256");
  async function visit(path) {
    for (const entry of (
      await readdir(join(root, path), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", ".wrangler", "__pycache__"].includes(entry.name))
        continue;
      const name = join(path, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        hash.update(name);
        hash.update("\0");
        hash.update(await readFile(join(root, name)));
      }
    }
  }
  await visit("ocr");
  hash.update(await readFile(join(root, "worker/package-lock.json")));
  return hash.digest("hex");
}
export function ocrUnchanged(previous, hash, inventory) {
  return (
    previous?.ocrSourceHash === hash &&
    JSON.stringify(previous.ocrVersions) ===
      JSON.stringify(deploymentVersions(inventory.ocrDeployments)) &&
    previous.ocrImage === inventory.ocrApp.configuration.image
  );
}
export async function uploadWorker(m, api, settings, source) {
  const form = new FormData();
  form.set("metadata", JSON.stringify(workerMetadata(m, settings)));
  form.set(
    "bundle.js",
    new File([source], "bundle.js", { type: "application/javascript+module" }),
  );
  return api.call(`/workers/scripts/${m.worker}`, {
    method: "PUT",
    body: form,
  });
}
export async function rollbackWorker(m, api, versions) {
  if (
    !versions?.length ||
    versions.reduce((sum, v) => sum + v.percentage, 0) !== 100
  )
    throw new Error("No complete recovery deployment is available");
  return api.post(`/workers/scripts/${m.worker}/deployments`, {
    strategy: "percentage",
    versions,
    annotations: {
      "workers/message": "SECOP infrastructure deployment recovery",
    },
  });
}
