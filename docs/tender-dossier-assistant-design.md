# Tender dossier and company-fit MCP service

Status: approved by the user. Implementation planning identified the existing
Savia MCP adapter as read-only; the transport clarification below preserves the
approved no-custom-Savia-server boundary.

## Goal and boundary

Implement the SECOP dossier, company-fit assessment and tender conversation in
this repository. Savia consumes fixed MCP read tools and existing generic HTTP connector actions
for mutations/generation, and renders their results in its
procurement.secop plugin. No SECOP-specific endpoint, migration, assistant context
or background worker is added to Savia's server. The plugin may use existing
Savia collections, files and source actions without extending their contracts.

A dossier combines the tender description and every discoverable official
attachment, extracts requirements with evidence, compares them with a company
profile and supports persistent grounded conversations. Preparing an application
is in scope; submitting bids, signing, paying and sending communications is not.

## Current repository findings

The checked-in Worker exposes search, detail and filename-based document search.
It has OAuth KV but no dossier database, file bucket, queue, extraction pipeline
or AI provider configuration. OAuth approvals currently set userId=secop-user and
grant only mcp:read. That is adequate only for shared public reads, not private
company evidence. The deployed source also has catalog and process-document
capabilities absent from these sources, introduced during the Savia integration.
Before deploying any new bundle, reconcile those additive capabilities against
the known adapter in Savia and the deployed tool inventory. Preserve OAuth keys,
existing grants and public read behavior. Do not overwrite the live service with
this older baseline.

## Architecture

Use a Cloudflare D1 database for private records and job state, an R2 bucket for
originals/extracted evidence and Cloudflare Queues for asynchronous processing.
Persist checkpoints and leases; the browser and MCP request lifetime never own
background execution. Keep processing modular: inventory, verified download,
extraction, requirement synthesis, company comparison and grounded conversation.
Use an explicit configured AI/extraction provider adapter. Provider failures
remain visible; a fallback must not manufacture an analysis.

Extend OpenTofu and development bindings without recreating the OAuth namespace
or replacing unrelated settings/secrets. Retain public read tools when the new
bindings are absent; private tools fail with a configuration error. Tests use
injected adapters; production startup must never select a fake adapter. Document
the Cloudflare deployment requirements. The existing optional Docker target must
retain its public-proxy behavior and report unsupported private capabilities
rather than silently using ephemeral memory for them.

## Private identity and authorization

Provision an opaque owner for each explicitly approved private connection and
carry it in verified OAuth grant properties. Never derive ownership from a
caller-provided workspace/company ID, an unverified client name or the existing
shared secop-user value. The owner represents one dedicated Savia workspace
connection; do not share that grant between workspaces. Provide a reconnect/setup
flow that clearly explains this isolation boundary.

New scopes separate dossier reads, dossier writes, company evidence management
and conversation generation. The consent screen describes storage, processing
and the configured AI recipient. Existing mcp:read grants retain public tools
but cannot access private records; reconnect is required for new permissions.
Pass verified principal/scopes from the OAuth handler into MCP tool execution,
and check them for every record, file, job and citation access. Direct API-key
public access never confers private access. Reject unconfigured access-code
validation instead of treating a missing API_KEYS configuration as approval.

## MCP contract

Use Spanish tool names consistent with the current API, with structured results,
input schemas and explicit read/write annotations. The proposed tools are:

- preparar_expediente: validate a process ID, create/reuse its owner-scoped
  dossier and enqueue a resumable refresh; return dossier and job IDs.
- consultar_expediente: return revision, description, complete inventory,
  coverage, requirements, report, pending items and job progress, with pagination.
- reintentar_documento: retry a failed inventory item without duplicating work.
- registrar_documento_expediente: accept a bounded manual attachment for a
  blocked item using a protected upload flow; return validation/progress state.
- guardar_perfil_empresa / consultar_perfil_empresa: maintain a versioned
  reusable company profile and list evidence owned by the same connection.
- registrar_evidencia_empresa: attach bounded company evidence with provenance,
  effective dates and extraction status; never trust a supplied remote URL.
- evaluar_empresa: enqueue comparison for explicit dossier/profile revisions.
- consultar_evaluacion: return requirement-level findings and missing tasks.
- conversar_licitacion / consultar_conversacion: answer against authorized
  dossier/company evidence and preserve the conversation with revision checks.

Public search/detail/catalog tools remain compatible. MCP errors include stable
codes, retryability and safe recovery information. Identifiers alone never grant
access. Private citations are served through scoped MCP retrieval or short-lived
protected download links, never public R2 URLs.

## Coverage, extraction and revisions

Enumerate every page of official process-document results, deduplicate by source
identity and distinguish inventory completion from extraction completion. Record
file hash, source link, fetch time, document version, MIME type and parser version.
Show pending, ready, blocked, unsupported, oversized and failed states. State that
coverage concerns the available public catalog, which may omit official files.

Allowlist official SECOP download hosts/paths, validate each redirect and enforce
byte/time limits. CAPTCHA produces a human-help state with the official link and
manual upload recovery. Do not solve or bypass it automatically. Never allow a
model or client to choose arbitrary fetch destinations.

Extract page-aware PDFs, scanned PDFs via configured OCR, DOCX and XLSX tables.
Bound archive expansion, nesting and paths; unsupported/encrypted files stay
visible and prevent an unqualified complete status. Define explicit configurable
limits; exceeding them reports affected files instead of quietly truncating.

Persist chunks with page/section and exact excerpts. Synthesize requirements
across all successfully extracted documents, not only retrieved top-k snippets
or previous summaries. Chat retrieves original evidence from a specified corpus
revision. Cite actual document versions and pages only when extraction provides
them. New or removed documents mark reports stale. Reuse unchanged extraction.
Adendas supersede terms only with evidence; ambiguous contradictions are flagged.

## Company fit and application preparation

Profiles distinguish user assertions from supporting documents. Store evidence
versions, fiscal periods and expiry dates where provided. The user selects the
company and relevant lot; do not infer them from account names.

Requirements include original wording, category, mandatory/scored classification,
lot, deadlines and citations. Assessment states are meets, does_not_meet,
insufficient_evidence and not_applicable. Every finding links tender evidence and
company evidence, or identifies exactly which evidence is missing. Unknown,
expired, unreadable and contradictory facts cannot produce meets. Deterministic
amount/date/ratio checks complement model interpretation. Overall readiness
remains conditional when mandatory documents are unprocessed or evidence missing.

Missing tasks record the requested document/action, requirement, optional owner
and due date. User review/overrides have audit notes and survive recomputation;
changed evidence flags them for review. Reports and chat explain scope,
eligibility, experience, finances, guarantees, deliverables and evaluation rules,
then provide a practical preparation checklist and requested drafts.

## Persistence and jobs

Schema entities: owners, dossiers, document versions, chunks, company profiles,
company evidence, requirements, assessments, preparation tasks, conversations,
messages and jobs. All private tables include owner identity. Every query and
storage-key lookup enforces it, including job retries and AI retrieval.

Jobs use idempotency keys by owner/process/corpus revision, leases, bounded
concurrency, retry backoff and durable per-file progress. Queue delivery may
repeat; effects must be idempotent. Model requests receive only authorized
content, treat source text as data, and have explicit budget/time limits. No
provider key or grant token appears in stored reports or logs. Cancellation
stops new work and preserves completed extraction.

## Plugin integration and delivery

The existing Savia MCP action adapter explicitly rejects write tools. Expose
private service operations through a parallel /private/v1 HTTP interface using
the same service contracts and owner checks. Use a separate scoped per-owner
bearer credential configured in Savia's existing secret-backed HTTP connector;
public API_KEYS do not grant private access. Never mislabel writes as read-only.
Generate the HTTP schema from the shared Zod contracts.

Update only procurement.secop plugin sources in Savia for Overview, Documents,
Requirements, Company fit and Assistant views. The plugin stores no credentials,
downloads no arbitrary URLs and accesses this service through existing authorized
MCP action contracts. Before implementation, verify those contracts can transport
private tool results and bounded upload data. If not, keep the upload UI on this
service with a protected authorization flow; do not introduce custom Savia routes.

Create a code PR in this repository, run CI and validate bindings/migrations in
an isolated service environment before deploying compatible tools to the existing
SECOP endpoint. Verify existing OAuth/public searches/catalogs first, then connect
the scoped private source in tenant 12 of shared savia-preview.hefesoft.com.
Install the updated plugin and verify with real authorized documents. Do not
replace shared Savia or delete its business records.

## Acceptance

Tests cover public API compatibility, private scope/owner enforcement, missing
configuration, all-page inventories, duplicate jobs, lease expiry, recoverable
partial extraction, CAPTCHA, byte limits and unsafe redirects. Use more than one
inventory page and a mixed document set including an amendment and a scanned or
unsupported file. Verify exact citation resolution, stale-report detection,
company unknown/expiry/threshold cases and user review preservation. Test chat
history/revisions, document prompt injection and cross-owner access denial.

Live verification must show progress after closing/reopening Savia, a combined
report citing multiple files, questions answered from the actual corpus and a
company-fit matrix with actionable missing evidence. Report partial coverage and
unconfigured OCR/providers honestly. Unit tests alone do not prove deployment.
