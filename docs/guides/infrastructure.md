# Reproducible live infrastructure and deployment

SECOP owns this infrastructure independently of Savia. `infra/production.json`
is the non-secret inventory of the existing live resources. Resource names and
IDs are pinned deliberately: this is an **adoption**, not a new environment.

## Ownership

| Component                                                          | Declarative owner                               | Protection                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| D1, private R2, OAuth/catalog KV, job/dead-letter queues           | `tofu/live/main.tf`                             | Import blocks, `prevent_destroy`, no mutation allowed by the adoption plan gate                         |
| Vectorize 1024/cosine and owner/tender/generation metadata indexes | `infra/production.json`, `infra/cloudflare.mjs` | Exact configuration check; additive metadata creation only; no index deletion/replacement               |
| Queue consumer and reconciliation cron                             | Inventory and API reconciler                    | Existing consumer identity and target checked; update only those pinned objects                         |
| OCR Worker, existing Durable Object, container image/capacity      | `ocr/wrangler.jsonc` and inventory              | Namespace/application IDs verified before and after; private endpoint, standard-2, one maximum instance |
| SECOP Worker code, bindings and non-secret variables               | Inventory and `infra/release.mjs`               | All existing secrets retained, unknown non-secret bindings block release                                |

The pinned Cloudflare provider (5.28.0) has no Vectorize/Containers resources,
does not support importing queue consumers, and cannot faithfully read the live
cron representation. The API/Wrangler reconciler fills those gaps in the same
entry point. The D1 resource is immutable (`ignore_changes = all`) because this
provider reports changes to computed database statistics after import; its ID
and name are independently checked through the API. Schema changes are not
managed through this database resource.

`tofu/` remains the historical fresh/sandbox/Docker scaffold. **Do not apply that
root to the live service**: its generated names and secret management are not
the live adoption configuration. `worker/wrangler.toml` is local development only
and deliberately uses a different Worker name. Production uses the commands below.

## Commands

Requirements: Node 22+, OpenTofu 1.13+, Docker for changed OCR images, and the
locked Worker toolchain (`npm ci --prefix worker`).

```sh
npm run test:infra
npm run infra:plan
npm run infra:deploy
npm run infra:check
```

`TOFU_BIN` can select a specific OpenTofu executable. Authentication uses
`CLOUDFLARE_API_TOKEN` or the operator's existing Wrangler login; run
`worker/node_modules/.bin/wrangler whoami` if the local OAuth session expired.
No secret values belong in the inventory, command arguments, Git, CI artifacts
or Terraform variables/state.

- `plan` reads Cloudflare, validates pinned identities and produces a protected
  import plan; it does not change remote resources. Output/logs are private in
  `infra/.state/<run-id>/`.
- `deploy` repeats preflight; backs up D1, both Worker bundles/settings and the
  current inventory; persists recovery copies under the **existing private R2**
  prefix `ops/deployments/<run-id>/` (after checking that r2.dev and custom-domain public access are disabled); imports resources; adds missing Vectorize
  metadata indexes and reconciles the pinned cron/consumer; builds and deploys
  OCR before the main service; verifies bindings, secret names, record counts,
  public health and rejection of unauthenticated private requests.
- `check` only verifies current configuration and record counts. It never starts
  analysis or OCR jobs.

The OCR image rebuild is skipped only when both the source hash and the live
Worker version/container digest match the last verified release receipt. A stale
cache or external deployment forces a rebuild. The first adoption deploy builds
OCR once. Ordinary deployments reuse Docker's layer cache too.

## State and concurrency

`tofu/live/terraform.tfstate` is local, ignored by Git and contains only resource
metadata, not secret values. Keep it private. Every resource has an explicit
import block, so a fresh machine/CI runner can reconstruct state without creating
resources. Destruction, replacement and updates to adopted storage resources are
rejected before `apply`. Identity mismatches and missing resources fail closed;
this entry point intentionally does not bootstrap replacement empty storage.
A new environment requires its own reviewed inventory and provisioning plan.

Commands take a local exclusive lock. The manual `Deploy SECOP` GitHub workflow
serializes production runs. Do not run local deployments concurrently with CI or
another operator: there is no cross-machine lock/remote Terraform backend yet.
A crashed local run may leave `infra/.state/deployment.lock`; inspect the running
process and recovery logs before removing a stale lock.

The GitHub workflow requires an existing `CLOUDFLARE_API_TOKEN` secret in the
repository or `production` environment. No deployment credential is created or
copied automatically. It needs access to this account's Workers/scripts,
KV, D1, R2, Queues, Vectorize, Containers and image registry. Restrict resource
scope where supported. The workflow caches only the verified non-secret release
receipt; D1 exports and raw recovery artifacts stay in the private R2 bucket.

## Data and recovery

The deployment command never deletes resources, vectors, KV entries, R2 objects,
dossiers or company evidence. Database content counts by record kind are compared
before/after. Background jobs can legitimately add records during deployment.
Existing source files stay in the same bucket; no file copy/migration is needed.
Recovery objects are additive and have no automatic retention/deletion policy.

Worker version IDs, source/settings snapshots, the old immutable OCR image digest
and the D1 export are recorded before release. Main Worker verification failures
restore the previous traffic deployment only if no concurrent release replaced
this command's deployment. An ambiguous/concurrent failure stops for inspection.
Cloudflare deployments across OCR, queues and the main Worker are not an atomic
transaction: successful OCR/API reconciliation stays in place on main rollback.
Keep those changes backward compatible. No database restore runs automatically.

For manual recovery use the recorded Worker version IDs with Cloudflare's normal
version rollback, and the recorded OCR image digest with the original
`CpuOcrContainer` class/migration and namespace. Confirm identities before restoring.
Restore a D1 SQL backup only as a separately reviewed data-recovery operation;
never overwrite current data merely because a code deployment failed.

Schema changes require separately reviewed additive `worker/migrations/` SQL;
the adoption release does not replay schema SQL or truncate existing tables.
The initial schema already exists on this live database.
