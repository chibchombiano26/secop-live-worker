# Private dossier service operations

The private service is optional. Existing public REST/MCP reads work without D1,
R2, Queues or private credentials. Savia's server does not implement this feature.

## Live deployment

Use the [unified infrastructure entry point](guides/infrastructure.md) for the
existing live service. `npm run infra:plan` validates adopted resource identities;
`npm run infra:deploy` preserves the current storage, credentials and OCR namespace.
The provisioning checklist below applies to a separate new/validation environment.
Do not apply the historical `tofu/` scaffold over the live service.

## Provision and configure

1. Preserve the current Worker source/version, settings, secret names, OAuth KV
   namespace and catalog KV namespace. Reconcile all five public tool contracts
   before replacing a deployed bundle. Never run an unapplied Terraform state
   against existing resources without import and review.
2. Provision an isolated validation Worker, D1 database, private R2 bucket, OAuth
   KV and a job/dead-letter queue. Set the D1/R2/Queue bindings DOSSIER_DB,
   DOSSIER_FILES and DOSSIER_QUEUE. Apply `worker/migrations/0001_dossiers.sql`
   before private traffic. Configure the consumer with batch size 1, concurrency
   2 and five delivery retries; schedule reconciliation every minute.
3. Configure a real extraction provider: either AI.toMarkdown via a Cloudflare AI
   binding, or EXTRACTOR_URL/EXTRACTOR_KEY using the contracted OCR response in
   README.md. Cloudflare extraction retains a review-required warning; it does not
   claim complete OCR for every scanned page. Test PDF, scanned/unsupported, Office
   and archive behavior before advertising coverage.
4. Configure MODEL_NAME and AI for a Cloudflare model, or MODEL_URL/MODEL_KEY for
   the selected HTTPS OpenAI-compatible provider. The Preview rollout uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with MODEL_MAX_INPUT_CHARS=50000 to leave room for output within its context window. Requirement extraction visits every source chunk; cross-document groups and chat retrieval use bounded inputs. An oversized input fails visibly rather than truncating source text. MODEL_MAX_CALLS defaults to 64
   per attempt, MODEL_DAILY_LIMIT to 1000 per owner. Long corpora yield between bounded attempts and resume from checkpoints; daily
   model budget exhaustion waits visibly until the next UTC budget window. Validate the actual selected model's context
   window against MODEL_MAX_INPUT_CHARS and the output allowance. The service ceiling is 120000 characters; each deployment may lower it.
   `MODEL_TRANSPORT=workers_ai` routes the configured `openai/gpt-oss-120b`
   through the existing Cloudflare AI binding without changing its synthesis
   cache identity. The OpenRouter URL and secret remain configured for the
   separate Flue study agent; identify both processors in `AI_PROVIDER_LABEL`.
5. Provision a separate opaque owner per Savia workspace. Generate high-entropy
   access codes and REST bearer credentials using a cryptographic RNG. Store only
   their HMAC-SHA256 purpose-separated digests in secret PRIVATE_CONNECTIONS and
   a 32+-character PRIVATE_AUTH_PEPPER. Public API_KEYS never grant private access.
   Keep code/token values out of Git, logs, ZIPs and shell arguments. Configure
   AI_PROVIDER_LABEL to identify the processor on the consent screen.
6. Keep one dedicated private credential in the existing Savia plugin HTTP
   connector `secop-dossier`. Do not reuse it in another workspace. Private MCP
   scopes require an explicit new OAuth consent; old public grants are unchanged.
   Direct REST and OAuth identity mappings resolve to the same stable owner.

OpenTofu resources are opt-in with `enable_dossiers`. The optional Docker target
continues to serve only the public proxy. Missing private bindings fail closed
instead of using transient memory.

## Contracts and processing

`/private/openapi.json` generates route contracts from the Zod definitions.
The plugin calls one fixed authenticated `/private/v1/dispatch` operation so its
store package stays below Savia's 20-action limit. Its operation enum, input
schema and required scope are validated server-side; clients cannot select URLs
or owner identities. MCP private tool inputs use `{input:{...operation fields}}`.
Read-only annotations remain honest; mutations are never disguised as reads.

Inventory discovery scans all available pages twice for a stable manifest.
Descriptions and attachment versions have persisted citation text. Downloads
accept only the official SECOP archive endpoint and revalidate redirects. HTML
or authentication/challenge responses become human-help states. Manual upload
uses a single-use 10-minute ticket in the URL fragment, then a bounded same-origin
POST. No CAPTCHA bypass is implemented.

Synthesis reads every extracted chunk, checkpoints model parts and compares the
requirements across source groups. Source excerpts/pages are validated before
saving. Ambiguous amendments remain review items. Company findings distinguish
missing evidence from failed conditions; numeric comparisons require reviewed,
cited figures with matching units and periods. User review is an explicit audit
record, separate from model findings. Effective findings and readiness apply the latest matching user decision; raw model findings remain intact. A prior decision is reused only for the same requirement fingerprint and company evidence revision. Changed inputs require review.

Jobs survive browser closure and delivery duplication. Leases last 120 seconds;
processing renews them at checkpoints. New jobs attempt immediate queue delivery after persistence; the durable outbox recovers missed deliveries every minute. A failed job can be explicitly retried; a cancelled job stops new work at
its next checkpoint while preserving completed evidence. Conversations pin corpus
and company revisions, validate citations and atomically append turns to prevent
orphaned/duplicated messages. Refreshes mark prior answers/reports stale.

The configured deployment intentionally has finite file, archive, record, corpus,
model and rate limits. An explicit limit error is not successful complete analysis.
Large-corpus capacity can be increased with a separately reviewed storage/
processing change; never remove bounds or truncate documents silently.

## Verification and release

Run `npm ci`, `npm test -- --maxWorkers=1`, `npm run typecheck`, `npm run bundle`
in worker. CI runs the Miniflare-backed worker suite with one Vitest worker to
avoid process contention between integration tests. Integration tests use Miniflare
D1/R2, plus fixture extraction/model adapters; they are not proof of production
model quality. Run OpenTofu fmt/validate after backend-free
init. Verify real extraction and model calls on the isolated service before
promoting a compatible bundle to the existing SECOP endpoint.

Before promotion, compare public search/detail/catalog/document tool discovery,
check the existing OAuth connection and preserve every existing binding/secret.
Apply additive production database migrations and new resources, then activate the
compatible plugin in tenant 12 at `https://savia-preview.hefesoft.com`. Do not
replace that Savia host with a branch environment.

Verify a public tender, all inventory pages, a recoverable blocked file, a cited
multi-document report, company gaps and a follow-up conversation across reload.
Company acceptance testing uses user-authorized files. Synthetic validation data
is labeled and isolated under its own owner; it is never presented as the user's
actual company. Capture desktop/mobile screenshots and report coverage and any
unavailable providers honestly.

For rollback, redeploy the backed-up compatible Worker version and reactivate the
previous plugin version. Keep additive D1/R2 data and OAuth namespaces. Never purge
business records to roll back code. API health alone does not establish private
service readiness.

## Retention and incident handling

Originals persist until explicit removal by default. ORIGINAL_RETENTION_DAYS
expires originals only; extracted evidence, reports and audit history remain.
Company evidence deletion requires `confirmed:true`, redacts extraction, marks
assessments stale and may leave quotations in existing conversations/reports.
Explain that impact to the user. For complete data-erasure requests, first review
all derived records rather than treating original-file deletion as full erasure.

Remove an owner's PRIVATE_CONNECTIONS entry to revoke private REST access and
private MCP operations. Keep the pepper stable during routine token rotation;
replace the owner's purpose-separated digest, preserve its opaque owner ID and
update only the intended workspace connector. A pepper change invalidates all
private credentials and requires an explicit migration/rotation plan.
