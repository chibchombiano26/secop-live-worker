# Expert SECOP Dossier Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user ask Savia's dossier chat to evaluate requirements against a selected company and save a sourced preparation plan, with bounded Flue tools, durable memory and existing task/Office actions.

**Architecture:** Keep owner/dossier Flue identity and Workflow admission stable. A validated, budgeted expert request selects server-owned adapters; authoritative answers, evidence and effects remain in SECOP D1/R2. Preserve Savia's current provider contract, generic task editor and Office source-key reuse.

**Tech Stack:** TypeScript, Zod, Flue 2.3.0, Cloudflare Workers/Workflows/Durable Objects/D1/R2, OpenRouter, Vitest/Miniflare.

**Spec:** `docs/superpowers/specs/2026-10-17-expert-dossier-agent-design.md` (approved).

## Global Constraints

- SECOP owns domain logic and durable state; no browser persistence or new procurement backend in Savia.
- Every adapter derives owner/dossier/company/job/lease from trusted saved delivery, never model selectors.
- Persist originating credential permissions. Legacy requests without permissions may answer but never gain new write capabilities.
- New plan/memory/proposal effects require original `dossier:write`; company assessment requires original `company:write`; `dossier:read` permits advice only. Savia task creation continues to enforce the host collection permission.
- No submission, signing, communications, credential changes or automatic evidence approval.
- Every claimed requirement/finding has validated sources and current revision/coverage qualification.
- Advice/evaluation must not create preparation tasks or proposal files implicitly.
- Reuse saved drafts; never overwrite Office edits. Never claim a Savia task exists without a successful Savia action receipt.
- Preserve existing resource identities, API compatibility, secrets, budgets and replay behavior.
- Code/docs/tests in English; user-facing answers in Spanish.

## Review Focus

- Assessment currently upserts tasks: repeated evaluation must neither create tasks implicitly nor reset edited task owners/dates (Task 3).
- An old queued request or an instruction embedded in a PDF cannot acquire write permissions or authorize a plan/proposal (Tasks 1, 4).
- Switching company within the same dossier must not reuse another company's plan, decisions or assessments (Tasks 2, 4).
- An amendment arriving after a tool read must prevent committing a current-looking result against the old corpus (Tasks 2, 4).
- A saved Office proposal may have manual edits: retry and model requests must preserve source-key reuse and expose existing actions rather than replace it (Tasks 4, 5).

## File and interface map

New SECOP modules under `worker/src/dossier/`:
- `expert-policy.ts`: Spanish procurement review policy and strict intent/allowed-action validation.
- `expert-state.ts`: scoped memory, preparation plans and idempotent action receipts.
- `expert-tools.ts`: adapters for coverage, review, company assessment, preparation planning and proposal preparation.
- `expert-study.ts`: bounded orchestration, model budgets, checkpoints and final grounded-answer assembly.

Modify `api.ts`, `conversations.ts`, `agent-scope.ts`, `processing.ts`, `repository.ts`, `assessment.ts`, `assistant-provider.ts`, `worker/src/agents/tender-study.ts` and `worker/src/cloudflare.ts` only for their owning tasks below. Use existing generic record storage; add typed entity kinds without a destructive migration. Do not rename the generated Flue class or binding.

Shared exported contracts:
- `ExpertAction = 'review' | 'evaluate_company' | 'save_plan' | 'prepare_proposal' | 'remember_decision'`.
- `SavedExpertAuthority = { scopes: PrivateContext['scopes']; requestHash: string }`, stored internally with the saved request; never accepted from client JSON.
- `ExpertContext = { ownerId: string; dossierId: string; companyProfileId?: string }` for authorized reads.
- `ExpertScope = StudyScope & { ownerId: string }` for active tool execution/writes, constructed by trusted intake only.
- `ExpertSnapshot = { dossierId: string; corpusRevision: number; reportId: string; companyProfileId: string | null; companyRevision: number | null }`.
- `ExpertPlanItem = { requirementId: string; sourceRefs: string[]; status: Finding['status']; nextAction: string; owner: string | null; dueDate: string | null }`.
- `ExpertMemory = { snapshot: ExpertSnapshot; decisions: Array<{ text: string; originatingTurnId: string }>; unresolvedQuestions: string[] }`. Decisions are assertions, never reviewed company facts.
- `ExpertPlan = { snapshot: ExpertSnapshot; originatingTurnId: string; items: ExpertPlanItem[] }`.

### Task 1: Preserve authority and validate expert requests

**Files:** new `expert-policy.ts`; modify `api.ts`, `conversations.ts`, `agent-scope.ts`; tests `dossier-expert-policy.test.ts`, `private-authorization.test.ts`, `dossier-agent.test.ts`.

**Interfaces:** Produce `authorizeExpertActions(message: string, proposed: ExpertAction[], authority: SavedExpertAuthority | undefined): ExpertAction[]`. It accepts model proposals only when supported by the literal saved user request and appropriate original permissions; ambiguity permits review and asks for clarification instead of writing.

- [ ] Write failing cases: advice allows review only; evaluation cannot imply plan/task/proposal generation; explicit save-plan plus `dossier:write` permits saving; insufficient permission, negation, quoted instructions and legacy request forbid writes. Client-supplied authority is rejected. Reusing an idempotency key with different scopes/request hash conflicts.
- [ ] Run `npm --prefix worker test -- test/dossier-expert-policy.test.ts test/private-authorization.test.ts test/dossier-agent.test.ts`; verify expected assertion failures.
- [ ] Implement strict authority capture in the existing chat admission path, separating internal metadata from public request parsing and idempotency comparison. Keep readStudyJob validating saved scope/lease and authorize each proposed effect through `authorizeExpertActions`.
- [ ] Rerun the same command; require green, including old request compatibility.
- [ ] Commit `feat: preserve scoped authority for expert dossier requests`.

### Task 2: Persist scoped preparation plans, memory and receipts

**Files:** new `expert-state.ts`; modify `repository.ts`; new test `dossier-expert-state.test.ts`.

**Interfaces:** Produce `readExpertState(repo, context: ExpertContext): Promise<{ memory: Stored<ExpertMemory> | null; plan: Stored<ExpertPlan> | null; stale: boolean }>` and `commitExpertEffect(repo, scope, input: { operationId: string; snapshot: ExpertSnapshot; expectedRevision: number; kind: 'plan' | 'memory'; value: ExpertPlan | ExpertMemory }): Promise<{ id: string; revision: number; duplicate: boolean }>`; type `repo` as DossierRepository and write `scope` as ExpertScope. Reads validate authenticated context without requiring a running job; writes require its live lease. Derive record keys from owner/dossier/company; validate scope, authority, snapshot and lease before mutation. Record the effect/receipt atomically using D1 conditional statements, not a read-then-write receipt gap.

- [ ] Write failing real-D1 cases: reload recovers state; foreign owner/company has no access; stale corpus/company and lost lease reject writes; concurrent revisions conflict; retry returns the original receipt and does not reset edited plan items. User decisions remain assertions after corpus change.
- [ ] Run `npm --prefix worker test -- test/dossier-expert-state.test.ts` and verify expected failures.
- [ ] Implement typed records and bounded/paginated reads; fail clearly on capacity limits instead of truncating requirements. Preserve existing task/file records and require original permissions from Task 1.
- [ ] Rerun state and repository tests; require green.
- [ ] Commit `feat: persist scoped expert preparation state and effect receipts`.

### Task 3: Expose evidence and company tools without implicit task writes

**Files:** new `expert-tools.ts`; modify `assessment.ts`; tests `dossier-expert-tools.test.ts`, `company-assessment.test.ts`, `dossier-checklist.test.ts`.

**Interfaces:** Produce `createExpertTools(repo: DossierRepository, scope: ExpertScope, model: ModelProvider)` with `inspectDossier()`, `reviewRequirements()`, `evaluateCompany()`, `savePlan(plan: ExpertPlan, operationId: string, expectedRevision: number)` and `prepareProposal()`. Inputs never accept an owner, dossier, company or document selector. Retain the existing assessment API default, adding `assessCompany(..., options?: { createTasks?: boolean })`; expert evaluation passes `createTasks: false`. Existing task generation must insert missing tasks without overwriting user edits on rerun.

- [ ] Write failing cases: complete review retains every requirement; missing company returns an explicit gap; expired/unreviewed evidence cannot establish compliance; evaluation creates zero tasks; assessment rerun preserves edited task owner/date/state; a foreign requirement or mismatched source reference is rejected.
- [ ] Run `npm --prefix worker test -- test/dossier-expert-tools.test.ts test/company-assessment.test.ts test/dossier-checklist.test.ts`; verify expected failures.
- [ ] Implement adapters using `buildExhaustiveChecklist`, current report/coverage, `assessCompany` and Task 2 state. `prepareProposal()` validates readiness and exposes the existing `proposal-docx` action; it does not claim to create/open an Office draft. Return explicit blockers when analysis or company evidence is missing.
- [ ] Rerun the same tests; require green and no silent omission of pending/unavailable sources.
- [ ] Commit `feat: expose evidence grounded expert dossier tools`.

### Task 4: Run the bounded expert workflow through Flue

**Files:** new `expert-study.ts`; modify `worker/src/agents/tender-study.ts`, `processing.ts`, `conversations.ts`, `cloudflare.ts`; tests `dossier-expert-study.test.ts`, `dossier-agent.test.ts`, `dossier-workflow.test.ts`, `dossier-conversations.test.ts`.

**Interfaces:** Produce `executeExpertStudy(repo: DossierRepository, job: Job, env: ProcessingEnv, adapters?: { model?: ModelProvider }): Promise<void>`. Reuse current chat completion semantics: persist the grounded turn and checkpoint `stage: 'answered'` only after requested effects and validated final answer are saved. Expose Task 3 adapters as actual scoped Flue tools; trusted intake enforces mandatory review and finalization. The model's free-form final acknowledgement is never authoritative.

- [ ] Write failing scenarios with controlled model outputs: review-only, evaluate-company, save-plan and remember-decision routes; missing company; forged tool selectors; PDF prompt injection; no unauthorized writes; all requirement categories represented or explicitly qualified. A compound review/plan request produces sourced gaps and saved plan, not only the old checklist shortcut.
- [ ] Run `npm --prefix worker test -- test/dossier-expert-study.test.ts test/dossier-agent.test.ts test/dossier-workflow.test.ts test/dossier-conversations.test.ts`; verify expected failures.
- [ ] Implement at most 8 proposed tool steps per turn, no model-led recursive dispatch, and one bounded planning call per resumable segment. All planning/evidence calls use the existing daily/model-call budgets with checkpoints; the Flue coordinator must not add unmetered duplicate inference. Persist a validated plan before executing it. Resume saved steps/receipts on retry, respecting current lease and snapshot.
- [ ] Add and run failure tests for budget pause between effects, duplicate delivery, cancellation, expired running job, company switch and amendment during processing. Require no duplicated effects, no stale success, and no paid replay of completed planning.
- [ ] Add expert quality fixtures: budget versus quotation with page citation; ambiguous/conflicting deadlines; unsupported experience years; missing OCR pages. Require source validation and explicit uncertainty instead of invented facts or compliance.
- [ ] Commit `feat: orchestrate bounded expert study through scoped Flue tools`.

### Task 5: Render saved expert results through existing Savia actions

**Files:** modify `assistant-provider.ts`, `conversations.ts`; tests `dossier-assistant-provider.test.ts`, `dossier-conversations.test.ts`, `dossier-proposal.test.ts`.

**Interfaces:** Extend internal saved ChatTurn with optional expert result/plan references. Keep public `PluginAssistantResponse` shape unchanged: text, citations, taskSuggestions, documentActions, pendingJobId and coverage. Existing stored turns remain readable. Use stable requirement IDs in task suggestions and preserve `proposal-docx` action identity/context for Office source-key reuse.

- [ ] Write failing cases: load after refresh renders saved plan and decision context; missing company is visible; stale revisions disable actionable current claims; task suggestions retain validated citations; preparing a proposal exposes the existing action; no answer says an Office file or Savia task was created without its host action receipt.
- [ ] Run `npm --prefix worker test -- test/dossier-assistant-provider.test.ts test/dossier-conversations.test.ts test/dossier-proposal.test.ts`; verify expected failures.
- [ ] Implement result rendering without introducing a second chat or new Savia-specific backend routes. Existing generic task editor gathers responsible person/date; absent values remain unset. Office action retains its current source-key lookup and opens an existing draft before generating another.
- [ ] Run the same command and existing Savia generic action tests in the SECOP plugin worktree: `pnpm --filter @savia/admin exec vitest run src/features/assistant/assistant-document-action.test.tsx src/features/assistant/assistant-task-action.test.tsx`. Require existing draft/manual-edit protection to stay green; do not edit unrelated Savia working-tree changes.
- [ ] Commit `feat: surface expert preparation plans in the existing assistant`.

### Task 6: Diagnose and restore the Preview plugin loading path

**Files:** source references in Savia: `packages/studio-server/src/plugin-store.ts`, `packages/studio-shared/src/plugin-entry-grant.ts`, `apps/api/src/routes/public-plugin-entry.ts`, `apps/admin/src/features/studio-engine/custom-plugin-frame.tsx`. SECOP plugin reference: `packages/plugin-secop-tenders/` in `/Users/casa/.codex/worktrees/secop-dossier-plugin/Savia v2`.

**Interfaces:** No new SECOP/Savia domain contract. Successful signed entry response must return JS MIME/CORS for the exact enabled installed version; expiry must produce a freshly issued grant through retry.

- [ ] Capture the fresh shell and signed module failure after one reload in Jose's Chrome tab. Record status, content type, CORS, active version and a redacted error code; never retain grant signatures or credentials in committed artifacts. An old expired URL cannot diagnose the original failure.
- [ ] Check exact artifact/enabled-installation/version consistency through authorized existing APIs. Distinguish expired/invalid signature, missing artifact, gateway/WAF and module parsing failures. Reproduce the demonstrated cause before changing deployment or code.
- [ ] For a code defect, write a focused failing regression in the existing adjacent loader/entry tests and run it, then apply the minimal generic fix and rerun. For operational drift, repair the existing artifact/configuration through its supported release flow without changing unrelated resources or credentials. Record what changed and why; no speculative reinstalls.
- [ ] Verify the licitation chat actually renders in Preview. If external access blocks repair, preserve the error evidence and report the exact UI verification blocker; do not substitute a backend test for UI success.

### Task 7: Verify, review, integrate and publish

**Files:** update `docs/guides/flue-dossier-agent.md`; extend existing release evidence under ignored local operations artifacts. Do not commit tokens, prompts or private company documents.

- [ ] Run `npm --prefix worker test`, `npm --prefix worker run typecheck`, `npm --prefix worker run bundle`, `npm run test:infra`, `npm run test:security` and `npm --prefix worker audit --omit=dev`. Record all failures, including pre-existing failures. Run only relevant Savia checks if Task 6 changes Savia.
- [ ] Request one fresh review of combined authorization, isolation, evidence completeness, writes/replay and budgets. Fix findings with regression tests, rerun affected checks, then review final diff and secret scan.
- [ ] Create/attach PR(s), obtain green required CI/CodeQL, integrate through the existing protected-branch path and verify main CI. Never bypass required checks or perform a destructive history rewrite for this feature.
- [ ] Deploy via existing SECOP `infra:plan`/`infra:deploy`/`infra:check` flow, preserving resource IDs, secrets and records; OCR build remains unchanged when its source fingerprint is unchanged.
- [ ] In Preview on CO1.REQ.10391118: request an exhaustive review and saved preparation plan; verify source PDF/page, a follow-up, refresh recovery, a task action and existing draft opening. Use a real selected company only if present; explicitly test missing-company behavior otherwise. Do not invent company evidence or claim positive eligibility.
- [ ] Record backend and UI results separately, usage/latency counts without sensitive contents, remaining gaps and any human verification required. Update the guide with capabilities, limits and supported example requests. No completion claim until acceptance evidence supports it.
