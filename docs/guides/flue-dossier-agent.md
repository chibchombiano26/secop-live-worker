# Private Flue dossier study agent

The SECOP Worker owns one Flue `TenderStudy` instance per authenticated owner and
dossier. Savia keeps using the existing private assistant provider, history and
source/proposal actions. No public Flue conversation route is mounted.

## Authorization and evidence

The agent ID is SHA-256 of a versioned owner/dossier tuple. Immutable initial data
is checked against that ID. Each delivery contains a server-created saved job ID,
lease and selected-company ID; every tool checks the saved request against these
values under the owner's D1 partition. A model cannot supply source, dossier,
owner or company selectors. There are no shell, sandbox or external MCP tools.

`inspect_current_dossier` reads processing coverage. `study_current_request` calls
the existing grounded-answer processor, including full-corpus review, exhaustive
saved requirements, company evidence and citation validation. A bounded success or failure tool
result terminates the agent turn. Processing failure codes return through D1 to
the Workflow so budget continuations still yield without consuming retry attempts.
Markers are cleared under the active lease on new attempts and durable-tool replay. Savia displays the authoritative saved answer,
not a free-form agent acknowledgement. Duplicate study calls reuse the saved
answer. Tracing is disabled for this integration. Models use OpenRouter with the encrypted
`OPENROUTER_API_KEY` Worker secret. Grounded analysis routes by price, disallows
provider data collection and uses low reasoning effort; the initial inexpensive
model is `openai/gpt-oss-20b`. Workers AI remains available for embeddings/OCR.

## Workflows and recovery

Queue messages admit a deterministic Workflow keyed by owner, job, attempt and
budget-resume epoch. Duplicate admission is acknowledged only after the existing
instance can be verified. An errored instance for an unclaimed queued job can be
restarted. The durable Workflow checkpoints the claim, Flue dispatch receipt and
reply read separately; retries reattach rather than prompting again. Non-chat
inventory, extraction, synthesis and company analysis run in durable processing
steps, retaining their existing D1 checkpoints and model-budget continuations.

D1 leases and idempotency remain authoritative. A stale lease, foreign request or
wrong company fails closed. The cron outbox recovers queued or expired work;
budget continuations get a new Workflow identity. The existing queue processor
remains available for local configurations without a Workflow binding.

## Build and deployment

`npm --prefix worker run bundle` uses the official Flue and Cloudflare Vite plugins,
inlines the existing PDF assets, then consolidates Worker modules for the existing
safe multipart uploader. The original OAuth/HTTP, queue and cron handlers remain.
`nodejs_compat` is required. Flue's generated SQLite class is permanently named
`FlueTenderStudyAgent`; migration `secop-flue-v1` is append-only. Never rename the
agent or replay a namespace-creation migration. Pin its assigned namespace ID in
`infra/production.json` after initial deployment.

Unified deployment preserves all existing resource identities and secrets, adds
only the new agent namespace/Workflow and verifies records afterwards. Existing
D1, R2, KV, Vectorize and OCR resources are not recreated. Cloudflare deployment
credentials additionally need Workflows Edit for Workflow reconciliation.

Flue 2.3.0 uses patched MCP client/SDK dependency overrides (2.3.1 and 1.32.1);
keep audit and compatibility tests green when updating those overrides.
The verified OCR build fingerprint covers OCR sources independently of the agent
dependency lock, so adding Flue does not rebuild the unchanged OCR container. No MCP
client is exposed to agent instructions.

## Validation

Run Worker tests/types/bundle, infrastructure tests, security hooks and npm audit.
Smoke-test the built module in Miniflare and verify health, authentication and
agent-route denial. Live validation uses an existing Savia Preview dossier and
checks cited sources, saved company context, Workflow execution and owner/dossier
isolation. Never use a synthetic success response as proof of a live AI run.
