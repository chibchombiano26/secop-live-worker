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

`inspect_current_dossier` reads processing coverage. A deterministic `useAgentStart`
intake calls the existing grounded-answer processor, including full-corpus review,
exhaustive saved requirements, company evidence and citation validation. A cheap
coordinator model cannot skip that required processing or choose its scope. The
Workflow displays the authoritative saved answer and ignores acknowledgement
failure after a verified answer is persisted. Processing failure codes return
through D1 so budget continuations yield without consuming retry attempts.
Markers are cleared under the active lease on new attempts and intake replay.
Duplicate study calls reuse the saved
answer. Tracing is disabled for this integration. Models use OpenRouter with the encrypted
`OPENROUTER_API_KEY` Worker secret. Grounded analysis uses the bounded provider
routing described below, disallows data collection and uses low reasoning effort; the initial inexpensive
coordinator model is `openai/gpt-oss-20b`; evidence study uses
`openai/gpt-oss-120b` to reduce confusion between quotations, awarded amounts and
official budgets. Both use low reasoning effort, and evidence responses request
the provider's constrained JSON schema. Workers AI remains available for embeddings/OCR.

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
budget continuations get a new Workflow identity and request queue delivery after
one second. A failed send remains recoverable through the persisted cron outbox.
The existing queue processor
remains available for local configurations without a Workflow binding.

A fresh dossier prepare/inventory request also retries a failed or cancelled
synthesis job for the current corpus revision, using its existing idempotency key
and preserving saved analysis checkpoints. It leaves queued, running and
succeeded synthesis jobs unchanged. Extraction completion does not revive a
cancelled synthesis job.

Synthesis reads cached analysis by exact content key within the current owner.
Extraction prefetches at most 80 fragment keys at a time and releases each window;
joint-review and split-fragment cache reads are batched on demand. Unrelated
historical cache entries cannot exhaust a global preload limit. Cache misses
recompute the requested analysis, while storage and integrity failures remain
visible instead of silently discarding evidence.
Each joint-review group includes only its referenced document/source tables,
with local source indices and unchanged global requirement indices. This keeps
large source catalogs within the request bound without dropping compared pairs.
Review cache version 3 separates these payloads from previous global tables.
Joint review checkpoints a contiguous completed-group cursor scoped to the
corpus revision, model and review-plan fingerprint. A resumed run skips that
durable prefix while uncached groups remain; out-of-order completions cannot
advance the cursor past a gap. Once the stage completes, it caches the ordered
summaries and deduplicated candidate list so later verification continuations
can reuse them without reopening every group cache entry. Bump the review-plan
version when its prompt, grouping rules or aggregate shape changes.
Candidate verification checkpoints a contiguous prefix against a fingerprint of
the review plan, model and ordered candidate pairs. A resumed verification skips
that completed prefix; after the remaining candidates finish, the worker reloads
the saved prefix in bounded parallel batches for deterministic final assembly.
If a proposed candidate's original quoted evidence still exceeds the model
context bound, the candidate is saved as unconfirmed with a deterministic
reason, counted as completed, and checkpointed. The worker does not shorten or
omit the evidence to force a confirmation; the cached result is reused on
resume.
Final requirements are saved in sequential batches of at most 100 records,
retaining deterministic IDs and every requirement in the published report.
This permits large dossiers without raising repository batch or byte limits;
an interrupted write can replay safely before report publication.

## Build and deployment

`npm --prefix worker run bundle` uses the official Flue and Cloudflare Vite plugins,
inlines the existing PDF assets, then consolidates Worker modules for the existing
safe multipart uploader. The original OAuth/HTTP, queue and cron handlers remain.
`nodejs_compat` is required. Flue's generated SQLite class is permanently named
`FlueTenderStudyAgent`; migration `secop-flue-v1` is append-only. Never rename the
agent or replay a namespace-creation migration. Code updates use a bounded deferred rollout (30 seconds) so long-running agents
do not silently retain previous code indefinitely. Pin its assigned namespace ID in
`infra/production.json` after initial deployment.

Unified deployment preserves all existing resource identities and secrets, adds
only the new agent namespace/Workflow and verifies records afterwards. Existing
D1, R2, KV, Vectorize and OCR resources are not recreated. Cloudflare deployment
credentials additionally need Workflows Edit for Workflow reconciliation.

The MCP server is pinned and overridden to patched version 2.3.1, including the
copy used by the build-time agents dependency. The MCP client/SDK dependency
overrides remain 2.3.1 and 1.32.1. Each HTTP request gets a fresh
MCP server instance, and tool inputs are capped at 16,000 elements to bound
adversarial or malformed payloads without restricting the largest supported
company profile. Keep audit and compatibility tests green when updating these
dependencies or limits.
The verified OCR build fingerprint covers OCR sources independently of the agent
dependency lock, so adding Flue does not rebuild the unchanged OCR container. No MCP
client is exposed to agent instructions.

## Validation

Run Worker tests/types/bundle, infrastructure tests, security hooks and npm audit.
Smoke-test the built module in Miniflare and verify health, authentication and
agent-route denial. Live validation uses an existing Savia Preview dossier and
checks cited sources, saved company context, Workflow execution and owner/dossier
isolation. Never use a synthetic success response as proof of a live AI run.

## Expert preparation tools

The saved user request captures the originating credential scopes and a request
hash. Legacy requests may still answer, but never acquire new plan/memory writes.
The expert workflow persists a bounded action plan before running it, retains
original-source requirement coverage, and can evaluate the selected company
without creating tasks implicitly. Explicit plan and decision requests persist
scoped D1 state with corpus/company revisions and atomic idempotent receipts.

Examples in the existing Savia chat:

- `Dime todos los requisitos y documentos para aplicar, con fuentes.`
- `Evalúa mi empresa y guarda un plan de preparación con lo que falta.`
- `Guarda un plan de preparación.` (without a company, every company check stays
  unverified; the assistant asks for a profile rather than choosing one).
- `Recuerda que participaremos en el lote 2.` (saved as a user assertion, not an
  approved lot selection or reviewed company fact).
- `Prepara un borrador de propuesta.` (prepares the existing document action;
  use that action to open/reuse the Office draft).

Plan/memory/proposal preparation requires original `dossier:write`; evaluation
requires `company:write`. Advice never implicitly creates a plan, task or file.
Ambiguous, hypothetical, quoted and negated mutation requests fail closed and
remain a review. Backend plans are not Savia tasks: use the existing task action
and editor to select a responsible person and date. Office source-key lookup and
manual edits remain owned by the existing host document action.

The shared expert policy reviews administrative/legal, financial, organizational,
experience, technical, guarantee, timetable and amendment questions with source
citations. Missing/expired/unreviewed support is insufficient evidence, never an
eligibility approval. Company source links require both the selected company and
its document-evidence association. Pending OCR and unavailable source warnings
remain visible, including when copying answers.

Planning and evidence inference share per-segment call and owner daily budgets.
The production model limits are 512 calls per resumable segment and 50,000 calls per owner per
day; concurrency does not increase either budget. No new model attempt starts
after ten minutes in a segment, preserving time for in-flight calls to settle
before the fifteen-minute Workflow step deadline. Larger segments reduce cached
replay overhead while keeping saved fragment checkpoints and both budgets.
Transient network failures, response-body timeouts, HTTP 429 and HTTP 5xx receive
at most three physical attempts with bounded backoff. Every physical attempt
consumes both the segment and owner daily budget and refreshes the job lease.
Unparseable JSON content from an otherwise valid model response receives the
same bounded physical retry budget. Malformed provider envelopes, truncation,
authentication errors and schema-invalid output are not retried by this
transport layer; source splitting and validation remain authoritative.
OpenRouter may return a generation error inside an HTTP 200 response, either
at the top level or inside its first choice. These errors are classified before
reading any partial content. Transient availability failures use the same bounded
physical-attempt budget and exclude the failed provider only for the remaining
attempts of that inference, preserving model identity, schema, privacy and price
constraints. Authentication, billing, permission, content-policy and invalid-request
errors do not trigger provider fallback. Token-length failures retain the existing
source-splitting behavior.
Model response failures carry bounded diagnostic metadata across Workflow steps:
the parsing phase, elapsed time, response shape, known provider/finish reason,
allowlisted error type and numeric provider error code when available. Diagnostics contain no prompts,
source excerpts, response text, credentials, or owner identifiers.

OpenRouter provider sorting defaults to `price`; production uses `throughput`
for the same configured model. `MODEL_PROVIDER_SORT` also accepts `latency`.
Production caps provider pricing at USD 0.15 per million prompt tokens and
USD 0.75 per million completion tokens via `MODEL_MAX_PRICE_PROMPT` and
`MODEL_MAX_PRICE_COMPLETION`. Both optional values must be supplied together
as positive finite numbers. Routing still requires structured-output support
and denies provider data collection.
Actual Flue envelope inference is additionally limited to eight calls per saved
job/day; tool inspection has an eight-call limit too. Receipt-backed retries do
not repeat completed effects or paid planning. The authoritative answer remains
the validated saved turn, not the coordinator's acknowledgement. No tool submits
an offer, signs, sends communications or approves company evidence.

## Complete long-document extraction

Requirement extraction visits every original evidence fragment with bounded
concurrency: eight calls by default and sixteen in production, configured with
`MODEL_EXTRACTION_CONCURRENCY` (an integer from 1 to 16). Indexed results retain source order, and each
fragment keeps its exact document version, original page and citation validation.
On failure or a model budget boundary, in-flight work settles and valid partial
cache entries persist before the job yields; the next attempt reuses them. This
does not increase the configured per-job or owner daily model budget. The joint
review still consumes the full extracted requirement set.
D1 `Network connection lost` errors during synthesis cache reads/writes and job
progress checkpoints receive at most three attempts with short bounded backoff.
Cache writes are value-idempotent, so retrying after an ambiguous successful
write does not increment its record revision again. Lease mismatches and other
D1 failures propagate without retry.

The joint comparison plan runs at most eight independent calls concurrently by
default. `MODEL_JOINT_REVIEW_CONCURRENCY` can raise this to at most 64; production
uses 64 for higher throughput. At the observed model latency this remains
below Workers AI's documented 300 requests per minute default; the account-wide
rate limit still applies. Candidate evidence verification groups up to four
uncached candidates into one bounded request, while retaining each candidate's
existing cache key and validation rules. Invalid, incomplete, truncated, or
oversized batches are discarded and recursively split down to the existing
single-candidate path. `MODEL_JOINT_VERIFY_CONCURRENCY` controls concurrent
verification requests from 1 to 32; it defaults to eight and production uses
32. Changing either concurrency limit does not change the planned requirement
pairs, candidates, cache keys, or result ordering. The plan retains
every planned requirement pair, and verification retains every candidate.
Completed group and verification results are cached before progress is
acknowledged. On failure, no more work is scheduled and all in-flight work settles
before resume; results are merged in original plan and candidate order so
completion timing cannot change candidate selection, conflicts, or amendments.
Verification retains the existing both-side citation and amendment rules.

When a joint review response truncates, within-block groups divide into left,
right and cross comparisons; cross-block groups divide one scope at a time. This
preserves every planned pair, including pairs spanning distant split boundaries.
The split marker is cached before child reviews begin, and successful leaves are
cached separately, so a resumed job does not repeat a truncated parent call.
Recursive child work is sequential inside each configured review worker.
Split aggregates may exceed one response's candidate and summary limits, so only
bounded leaf responses are schema-validated and cached as model output.
The planner packs blocks toward 27,000 characters while keeping each actual
request below the unchanged 48,000-character cap. A response with exactly 200
candidates, or one rejected for exceeding that schema cap, is treated as
saturated: its candidates are discarded, a split marker is cached, and its
children are reviewed. This prevents the model output ceiling from silently
clipping candidate coverage, and replay continues from cached split markers.

Uncached group inference narrows the response schema's candidate indices to its
original source-block ranges. Cross-block groups use disjoint left/right ranges;
diagonal groups retain within-block comparisons. This prevents cross-block
self-comparisons and out-of-group identifiers without changing the comparison
plan or legacy cache keys. Backend validation remains authoritative.

If a model response truncates or still has invalid citations after its correction
attempt, extraction divides that source fragment into two smaller sections with
up to a 200-character overlap. Original version and page metadata remain intact
and no source text is dropped. The saved partition decision and each completed
section are reused on resume. Recursive sections run sequentially within their
existing worker, preserving the configured extraction concurrency. A fragment of 200
characters or less that still truncates or has invalid citations fails
explicitly; partial or ungrounded model output is never accepted as a complete
requirements inventory.

When the selected company has no extracted supporting evidence, every applicable
requirement is marked `insufficient_evidence` deterministically, without a model
call per requirement. Declared profile capabilities never become verified
compliance, and all requirement IDs remain in the assessment. Selected-lot
applicability checks still apply.
