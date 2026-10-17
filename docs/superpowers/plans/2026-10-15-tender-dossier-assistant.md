# Tender Dossier MCP Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a persistent tender dossier, evidence-based company assessment and grounded chat through SECOP MCP and the existing Savia plugin.

**Architecture:** The private SECOP Worker owns authorization, D1 records, R2 evidence, queued processing and AI/extraction adapters. Savia uses existing read-only MCP actions and its generic authenticated HTTP connector for writes; only procurement.secop plugin code changes. Existing public tools and OAuth grants remain compatible.

**Tech Stack:** TypeScript, Cloudflare Workers/OAuth/D1/R2/Queues, Zod, Vitest, OpenTofu; existing React plugin in the Savia pnpm monorepo.

**Spec:** [Approved design](../../tender-dossier-assistant-design.md).

## Global Constraints

- No SECOP-specific endpoint, migration, assistant context or background worker is added to Savia's server.
- The owner represents one dedicated Savia workspace connection; do not share that grant between workspaces.
- Existing mcp:read grants retain public tools but cannot access private records; reconnect is required for new permissions.
- Direct API-key public access never confers private access.
- All private tables include owner identity.
- Unknown, expired, unreadable and contradictory facts cannot produce meets.
- CAPTCHA produces a human-help state with the official link and manual upload recovery.
- No provider key or grant token appears in stored reports or logs.
- Preparing an application is in scope; submitting bids, signing, paying and sending communications is not.
- Keep existing individual Savia PDF reports accessible. Do not replace shared Savia or delete its business records.

## Review Focus

1. A refresh overlaps a conversation: pin answers to a committed corpus revision; Task 8 tests this.
2. A user reconnects OAuth: private data stays attached to a verified stable owner, not a new random owner or shared secop-user; Task 2 tests this.
3. An inventory changes during pagination: report inconsistent discovery and retry rather than publish a complete revision; Task 4 tests this.
4. A company evidence file expires between assessment and opening the report: readiness becomes stale; Task 7 tests this.
5. A queue event is lost after a database commit: persisted jobs can be redispatched without duplicate analysis; Task 3 tests this.

## Execution and file map

Use branch codex/tender-dossier-assistant in this repository. At execution start, inspect applicable instructions and use the worktree skill to select/reuse an isolated checkout. The Savia plugin gets a separate branch based on current main; preserve unrelated local edits and do not add feature code to Savia apps/api or studio-server.

New Worker modules live under worker/src/dossier/, with contracts, repository, authorization, jobs, inventory, downloads, extraction, synthesis, companies, assessment, conversations, tools and uploads as distinct modules. Migration files live under worker/migrations/. Existing src/mcp.ts and src/index.ts only compose handlers; avoid putting the subsystem into either file. Each task below names its tests and owned interfaces. Commit only verified work at each task boundary.

### Task 1: Preserve the deployed public contract

**Files:** modify worker/src/{socrata,mcp,index}.ts and README.md; create worker/src/public/{catalogs,documents}.ts and worker/test/public-compatibility.test.ts.

**Interfaces:** preserve buscar_licitaciones, detalle_licitacion and buscar_documentos; restore opciones_licitaciones and documentos_licitacion with the exact input/output schemas used by the deployed Savia adapter. Export listProcessDocuments(env, processId, cursor): Promise<DocumentPage> and getProcessDetail(env, processId): Promise<TenderDescription> for Task 4. DocumentPage includes items, nextCursor and the discovery ordering/version signal when available.

- [ ] Add failing compatibility tests using fixtures from the existing adapter at Savia/packages/plugin-secop-tenders/provider/{catalogs,documents}.mjs. Assert process association, stable pagination and catalog completeness, not only tool names.
- [ ] Run `cd worker && npm ci && npm test -- test/public-compatibility.test.ts`; confirm the absent tools cause the expected failures.
- [ ] Port the additive adapter behavior into source modules without patching generated bundles. Preserve cache freshness, bounds and existing public auth. Record the deployed tool inventory before any later deployment.
- [ ] Run `npm test && npm run typecheck && npm run bundle`; all must pass. Commit `feat: restore deployed SECOP public tool compatibility`.

### Task 2: Establish private ownership and scopes

**Files:** create worker/src/dossier/{contracts,authorization}.ts, worker/test/private-authorization.test.ts; modify worker/src/{index,mcp}.ts and README.md.

**Interfaces:** PrivateContext = { ownerId: string; scopes: readonly string[] }; requirePrivateContext(verifiedGrant, requiredScope): PrivateContext; authenticatePrivateBearer(request, env): Promise<PrivateContext> provides the equivalent REST boundary. Use scopes dossier:read, dossier:write, company:write, conversation:write. MCP private ownership comes only from OAuth-verified grant properties. The parallel private REST interface verifies a distinct scoped bearer credential provisioned for the same owner, with only its digest stored server-side. Existing public API_KEYS never authorize it. A server-configured access-code-to-owner mapping binds reconnects to a stable opaque owner; store only a keyed digest for code lookup. Keep existing public API_KEYS separate.

- [ ] Add tests asserting old mcp:read and direct API-key requests cannot invoke private tools; forged owner input cannot change scope; same authorized private code reconnects to the same owner; distinct codes remain isolated; private REST credentials resolve the same owner while wrong/revoked credentials fail; missing private configuration fails closed.
- [ ] Run the focused test and confirm it fails before adding the boundary.
- [ ] Inspect the installed OAuth library's documented handler context, wire verified properties into MCP composition, and implement explicit private consent. Validate exact requested scopes, include AI processing disclosure, and never convert existing shared grants into private grants. Fail OAuth approval when its access-code configuration is absent.
- [ ] Run focused tests, all public regression tests and typecheck. Commit `feat: isolate private SECOP connection ownership`.

### Task 3: Durable storage and recoverable jobs

**Files:** create worker/migrations/0001_dossiers.sql; worker/src/dossier/{repository,jobs}.ts; worker/test/dossier-{repository,jobs}.test.ts; modify worker/wrangler.toml, worker/src/{index,socrata}.ts, tofu/modules/worker/{main,variables,outputs}.tf and tofu/{main,variables}.tf.

**Interfaces:** DossierRepository(env, context) owns all SQL and R2 key construction. Define createOrGetDossier(processId), readDossier(id), enqueueJob(input), claimJob(id), checkpointJob(id, lease, progress), completeJob(id, lease), cancelJob(id) and listDispatchableJobs(now), with owner checks inside each. Job kinds: inventory, extract, synthesize, assess. Leases last 120 seconds with renewal before expiry; dispatch reconciliation runs every minute. Retries use bounded exponential backoff, max 5 attempts. Message payloads contain job ID and owner reference, never credentials or document text.

- [ ] Add integration tests against local D1/R2 for cross-owner record/file/job denial, concurrent claim, expired lease, duplicate queue delivery, cancellation and commit-before-dispatch recovery.
- [ ] Run focused tests and confirm failures before schema/runtime implementation.
- [ ] Implement tables for owners, dossiers, versions/chunks, requirements/reports, company profiles/evidence, assessments/tasks, conversations/messages and jobs. Scope unique keys by owner and revision. Use an outbox-style persisted dispatch state and scheduled reconciliation; acknowledge queue deliveries only after safe completion/retry bookkeeping.
- [ ] Add optional bindings DOSSIER_DB, DOSSIER_FILES and DOSSIER_QUEUE and a dead-letter queue. Keep OAuth resources intact. Missing bindings return a private-capability configuration error while public tools still work. Document Docker's public-only capability.
- [ ] Run focused tests, full Worker checks, `tofu -chdir=tofu fmt -check -recursive` and `tofu -chdir=tofu validate` after backend-free init. Commit `feat: persist SECOP dossiers and resumable processing jobs`.

### Task 4: Complete inventory and safe original downloads

**Files:** create worker/src/dossier/{inventory,downloads}.ts, worker/test/dossier-{inventory,downloads}.test.ts.

**Interfaces:** refreshInventory(repo, dossierId, adapters): Promise<InventoryCheckpoint>; downloadOfficialDocument(url, limits): Promise<DownloadedDocument>. DownloadedDocument includes bytes, MIME, content hash and source metadata. Default file limit 25 MiB, download timeout 30 seconds, redirect limit 3; deployment configuration may lower limits. Source identity and hash identify immutable file versions.

- [ ] Add tests for 3 inventory pages, repeated/changed cursors, mismatched process IDs, inventory changes mid-discovery, removed documents, unchanged hashes, malicious redirects, timeout, HTML CAPTCHA and oversized files.
- [ ] Run focused tests and confirm the expected missing-function failures.
- [ ] Implement all-page checkpointed enumeration through Task 1 adapters. Detect repeated cursors and inconsistent snapshots; retain previous committed corpus until discovery finishes. Download only validated official SECOP targets, revalidate each redirect and verify MIME/signature before extraction. Persist blocked/oversized/unsupported states individually. New inventory marks prior report stale.
- [ ] Run focused and full Worker checks. Commit `feat: ingest complete SECOP document inventories safely`.

### Task 5: Versioned extraction and bounded manual uploads

**Files:** create worker/src/dossier/{extraction,uploads}.ts; worker/test/dossier-{extraction,uploads}.test.ts; modify deployment configuration and README.md.

**Interfaces:** ExtractionProvider.extract(file, signal): Promise<ExtractionResult>; ExtractionResult = { pages: Array<{ page?: number; section?: string; text: string }>; parserVersion: string; warnings: string[] }. saveExtraction(repo, documentVersionId, result): Promise<void>. The extractor is a server-configured HTTPS service adapter with a pinned response contract, authenticated with a server secret. No client-specified extraction endpoint.

- [ ] Add tests using PDF, scanned PDF, DOCX, XLSX, encrypted file and hostile archive fixtures; assert page provenance, table preservation, missing OCR disclosure and no successful state for unprocessed files. Test over-limit, expired/reused and wrong-owner upload tickets.
- [ ] Run focused tests before implementation and confirm failures.
- [ ] Implement the extractor adapter with bounded responses and timeouts. Support configured OCR and preserve parser provenance. Default archive limits: 100 entries, 100 MiB expanded total, nesting depth 1; reject path traversal. Persist originals and page/section chunks without silently truncating content.
- [ ] Implement a protected service upload page with single-use, 10-minute owner-bound tickets issued by authenticated MCP. The plugin opens this page rather than sending private files through a new Savia API. Validate uploads and associate manual replacements with the original blocked inventory item; preserve both source and manual provenance. Add configurable retention and an authenticated deletion operation with explicit impact information. Private upload ticket creation uses the authenticated HTTP interface for Savia because its MCP action adapter rejects writes.
- [ ] Run focused tests and Worker checks. Verify the selected real extractor handles each supported format before declaring production readiness; absence leaves explicit pending states. Commit `feat: extract dossier evidence and accept protected manual uploads`.

### Task 6: Cross-document report and requirements

**Files:** create worker/src/dossier/{model,synthesis}.ts and worker/test/dossier-synthesis.test.ts; extend repository methods for report revisions.

**Interfaces:** ModelProvider.generate(input): Promise<ModelResult>; synthesizeDossier(repo, dossierId, revision, model): Promise<DossierReport>. Model configuration is server-owned and uses an explicitly configured OpenAI-compatible endpoint/model, separate from caller input. DossierReport contains coverage, summary, requirements, conflicts, citations and revision. Citation = { documentVersionId; page?: number; section?: string; excerpt: string }.

- [ ] Add tests proving synthesis visits every extracted chunk across multiple documents, rejects fabricated excerpts/pages, resolves an explicit amendment, flags ambiguous contradictions, reports partial coverage and cannot commit over a newer revision. Test a source instruction requesting secret disclosure.
- [ ] Run focused tests and confirm failure before implementation.
- [ ] Implement bounded hierarchical extraction per document, deterministic citation verification and cross-document synthesis. Budget limits pause jobs with a visible reason, never drop late documents. Store model/version and provenance, not keys. Refresh reuses unchanged extraction and preserves old report revisions.
- [ ] Run focused/full checks. Commit `feat: synthesize cited tender requirements across the dossier`.

### Task 7: Company evidence, assessment and preparation tasks

**Files:** create worker/src/dossier/{companies,assessment}.ts and worker/test/company-assessment.test.ts.

**Interfaces:** saveCompanyProfile(repo, input, expectedRevision): Promise<CompanyProfile>; assessCompany(repo, dossierRevision, companyRevision, selectedLots, model): Promise<Assessment>; reviewFinding(repo, assessmentId, requirementId, decision, note, expectedRevision). Finding status union: meets | does_not_meet | insufficient_evidence | not_applicable. Evidence is ingested through Task 5, privately scoped.

- [ ] Add tests for missing, expired, asserted-only and contradictory evidence, unsupported company files, fiscal-period mismatch, exact numeric/date boundaries, lot selection, cross-owner profile IDs, expiration at report read time and reviewed findings surviving refresh.
- [ ] Run focused tests and confirm failure before implementation.
- [ ] Implement profile/evidence revisions, deterministic normalized comparisons and evidence-cited interpretive findings. Missing mandatory evidence or partial mandatory-source coverage prevents ready status. Return actionable tasks with requirement linkage, requested evidence, optional owner/date and audit history. Reading a report checks evidence validity and marks stale results; never rewrites history silently.
- [ ] Run focused/full checks. Commit `feat: assess company fit and track application gaps`.

### Task 8: Grounded conversation per tender

**Files:** create worker/src/dossier/conversations.ts and worker/test/dossier-conversations.test.ts.

**Interfaces:** answerTenderQuestion(repo, { dossierId; companyProfileId?; conversationId?; expectedRevision; message; idempotencyKey }, model): Promise<ConversationTurn>; readConversation(repo, id, cursor): Promise<ConversationPage>. Return cited answer, pinned corpus/profile revisions, coverage warning and updated conversation revision.

- [ ] Add tests for multi-document questions, company gaps, refresh during generation, answer citations, persistent pagination, duplicate submissions, conflicting revisions and unrelated owner/tender evidence exclusion. Assert malicious document instructions cannot invoke write tools.
- [ ] Run focused tests and confirm failure before implementation.
- [ ] Implement scoped lexical/full-text retrieval against original chunks and report requirements, including source metadata. Pin corpus/profile revisions before generation; retain a stale indicator if refreshed meanwhile. Validate citations and state insufficient evidence explicitly. Persist turns with optimistic concurrency; chat does not automatically refresh the entire dossier or execute application actions.
- [ ] Run focused/full checks. Commit `feat: add persistent evidence-grounded tender conversations`.

### Task 9: MCP composition and operational controls

**Files:** create worker/src/dossier/tools.ts and worker/test/dossier-tools.test.ts; modify worker/src/{mcp,index,openapi}.ts and README.md; add docs/operations.md.

**Interfaces:** registerDossierTools(server, dependencies, privateContext) registers the exact Spanish names in the approved spec. Add cancelar_trabajo and revisar_requisito as explicit writes, and scoped upload/delete operations required by Task 5. Every tool returns content plus structuredContent with a versioned { data, error? } contract. Errors have code, retryable and recovery fields. Public tools keep their existing results. Expose equivalent private operations under /private/v1 using the same Zod input/output contracts, PrivateContext and service functions; POST for mutations/generation, GET for read-only resources. Authenticate with Task 2 scoped private credentials. Generate request IDs and redact all authorization values.

- [ ] Add end-to-end MCP tests for scope checks on every tool, read/write annotations, invalid inputs, safe errors, job status/cancel/retry, protected citation access and missing bindings. Exercise equivalent REST routes, expired/revoked bearer credentials, wrong-owner IDs and request/body limits. Verify GET requests never trigger processing or issue tickets. Test public-only Docker behavior.
- [ ] Run focused tests, then compose task modules into verified OAuth handler context. Add per-owner model concurrency/rate and budget limits with recoverable errors. Generate REST/OpenAPI schema from the same Zod contracts for any new service HTTP route; do not hand-write divergent schemas.
- [ ] Run full Worker tests, typecheck, bundle and infrastructure validation. Commit `feat: expose dossier and company assistant MCP tools`.

### Task 10: Savia plugin UI through existing MCP contracts

**Files (Savia repo only):** packages/plugin-secop-tenders/{store.json,entry.tsx,savia-extension.json,styles.css}; create dossier.ts, dossier-panel.tsx, dossier-panel.css and test/dossier*.test.*; update docs/secop-tenders-plugin.md. No Savia host/server files change.

**Interfaces:** executeDossierAction<T>(api, actionId, input): Promise<T> wraps existing api.actions.execute. Existing code confirms MCP actions use executeMcpList/readOnlyTool, so writes must use existing kind:http store actions. Define a fixed, allowlisted SECOP dossier connector in store.json, with a workspace-scoped secret connection for Task 2 private REST credentials. Map actions to fixed /private/v1 routes and server-owned scopes; never accept arbitrary URLs or credentials from action input. Use MCP only for honest read-only tools. Validate HTTP templating and response redaction against existing gateway tests before UI work. Any remaining host limitation is reported as a blocker, not bypassed with a custom route.

- [ ] Add behavior tests for prepare/resume, partial coverage, retry, company selection/evidence status, requirement citations, missing tasks, chat history/conflicts and scoped upload links. Assert controls do not imply readiness when evidence is missing.
- [ ] Run focused tests and confirm expected failures. Implement Overview/Documents/Requirements/Company fit/Assistant panels using incumbent UI, accessible labels and responsive controls. Persist business state only through the MCP service; bounded status polling stops on terminal jobs and component disposal. Old PDF reports stay available separately. Retain icon styling and existing search/follow/alerts.
- [ ] Run plugin tests/typecheck, inspect actual desktop/mobile renders and run the Impeccable checks once. Bump from the latest installed/repository plugin version rather than assuming 1.5.3 is still latest; package and record SHA. Commit `feat: integrate SECOP dossier and company assistant plugin`.

### Task 11: Review, deploy and verify shared Preview

**Files:** docs/operations.md in this repo; delivery evidence in the Savia plugin guide as appropriate.

- [ ] Review the combined code diff and all authority, storage and model boundaries. Run CI-equivalent tests, bundle and infrastructure checks in the service repo, plus plugin checks in Savia. Fix review findings before delivery.
- [ ] Create and attach a code PR in each changed repository. Verify service migrations and real extraction/model adapters in an isolated SECOP service environment. Use test-only disposable evidence, not copied production company documents.
- [ ] Inspect current Cloudflare service bindings and deployed public tool inventory without exposing secrets. Apply additive infrastructure/migrations preserving OAuth KV and existing secrets; deploy a compatible Worker only after checks pass. Recheck public search, detail, catalogs and process-document tools before private setup.
- [ ] Provision the dedicated owner, scoped HTTP connector credential and optional private read-only MCP source connection for the requested Savia Preview workspace. Obtain any newly required security-sensitive consent at the actual action, and retain public search while reconnect occurs. Upload/activate the compatible plugin using the normal manager.
- [ ] With user-authorized real documents, verify all-page inventory, recoverable blocked file, combined cited report, company gaps, chat follow-ups, reload/resume and desktop/mobile behavior. Record coverage, limitations, models and exact versions. Do not claim complete coverage if files or providers remain unavailable.
- [ ] Report delivered functionality and concrete remaining blockers. Rollback switches to the prior compatible Worker/plugin while preserving additive data and OAuth resources; never delete business records to roll back.

## Self-review result

Every approved spec section maps to Tasks 1–11: compatibility (1), ownership (2), persistence/jobs (3), coverage/download (4), extraction/upload/retention (5), synthesis/amendments (6), company fit/review/tasks (7), chat/revisions (8), MCP/operations (9), plugin (10), deployment/acceptance (11). Review Focus conditions are explicitly tested in their owning tasks. Configuration, provider provisioning and consent are deployment dependencies, not silent mocks or reasons to alter Savia's host. No implementation or deployment has been performed by creating this plan.
