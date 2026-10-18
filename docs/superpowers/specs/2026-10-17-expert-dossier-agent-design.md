# Expert SECOP dossier assistant

## Intent and success criteria

Extend the deployed Flue integration into a dossier assistant that can answer
questions, compare a selected company against documented requirements, identify
evidence gaps, and save a preparation plan. The user interacts through Savia's
existing chat. Domain logic and durable state belong to the SECOP backend.

A representative request is: "Evaluate this tender against my company, tell me
what is missing, and prepare a plan with sources." The answer must distinguish
verified requirements, company assertions, reviewed company evidence, missing
information, and matters requiring human review. It must not claim that a generic
checklist or an OCR extraction proves eligibility.

## Current implementation and gaps

`TenderStudy` currently executes the existing answer processor deterministically
on intake and exposes only `inspect_current_dossier`. Its model acknowledges the
result; it does not yet plan multi-tool work. Existing processing already supplies
full-corpus review, exhaustive requirement lists, company assessment, citation
validation, proposal documents, queues, leases and resumable Workflows.

The private assistant provider already supplies source actions, task suggestions
and a proposal document action. Reuse those capabilities rather than duplicate
Savia's chat, task editor or Office integration. Company comparison is optional:
without a selected company, show tender requirements and explicitly identify the
missing company context; never silently select another company.

## Recommended design

Keep the scoped agent and Workflow, and replace the acknowledgement-only role
with a bounded expert workflow. Do not expose arbitrary MCP operations or give
the model a repository/client handle. Every tool remains a server-owned adapter
that derives owner, dossier, company, job and lease from validated delivery scope.

Use a shared expert policy covering legal/administrative, financial,
organizational, experience, technical, guarantee and timetable requirements;
applicability, lots, amendments, conflicts and extraction coverage. Evidence is
untrusted content, never tool instructions. The model may choose a bounded plan,
but server-side validation requires the appropriate evidence/coverage steps before
a final answer or a write is accepted. A model acknowledgement is not an answer.

Alternatives considered: a longer system prompt alone cannot execute or remember
work; replacing the grounded processor with unrestricted autonomous tool calls
would discard validated citations, completeness and retry controls. The bounded
adapter approach preserves those guarantees while enabling useful actions.

## Tools and execution boundaries

- Inspect the current dossier: versions, inventory, processing gaps and current
  report status. Do not present a stale report as current.
- Review requirements/sources: reuse exhaustive saved requirements and isolated
  hybrid retrieval. Comprehensive preparation requests must retain coverage of
  every requirement, not just top-k results. Focused questions may retrieve.
- Evaluate the selected company: reuse assessment processing and its reviewed
  facts, expiry, selected-lot and citation rules. Missing evidence is unknown,
  not a positive or negative eligibility determination. Resume large assessments
  through the existing budget/checkpoint mechanism.
- Save a preparation plan: persist one item per outstanding requirement, its
  source reference, verification state, proposed next action and explicit owner
  and due date if supplied. Otherwise owner/date stay unset. Reuse existing task
  schemas where possible and the existing task-suggestion UI. Saving a plan is
  distinct from claiming tasks were created in Savia. Explicit requests to create
  tasks can use the available task action; unsupported effects must be reported.
- Prepare a proposal: reuse the current document generation action and existing
  draft. Never overwrite manual edits or replace a saved draft automatically.
  A request for advice does not authorize document generation or task creation.
- Read/update working memory: retain explicit user decisions, unresolved
  questions and plan progress in the SECOP backend, separately from verified
  company facts. Statements in chat do not become reviewed compliance evidence.

Read-only tools can run to answer a question. Persist the originating credential
permissions with each saved request and enforce them in every adapter; never
infer write permissions from the agent identity or grant all private scopes to
a model-selected action. Plan/task/proposal writes require both the appropriate
original permission and an explicit matching user request. There is no tool for submitting an offer,
sending communications, signing, changing company facts to reviewed, or accepting
contractual commitments. Those capabilities remain outside this release.

## Durable state and isolation

D1 is authoritative for validated plans, memory and action receipts; R2 retains
files. No browser persistence is introduced. Memory and plans are partitioned by
owner, dossier and selected company; each carries corpus/company revisions and
originating turn references. The current Flue identity can remain owner/dossier,
but every delivery and tool must validate its selected-company context.

Each write uses a logical operation ID derived from the saved request and action,
optimistic revisions, and a durable receipt. Workflow retries and Flue replay
reuse that receipt. Recheck lease and revisions before committing any effect.
Concurrent turns cannot overwrite user decisions or create duplicate tasks/drafts.
A changed dossier/company marks derived conclusions stale; explicit decisions
remain traceable but cannot validate new evidence. Tool reads paginate rather
than silently truncate. Limits surface resumable progress or a clear limitation.

## Answers, budgets and observability

Keep the saved private-provider answer authoritative. Persist structured tool
results and validated citations before rendering an answer. Explain document
coverage, missing company evidence, pending OCR review, applicable deadlines and
what still needs verification. Preserve source opening, copy, task suggestions
and DOCX actions. Do not expose raw provider acknowledgements as findings.

Keep economical coordination separate from evidence analysis. Count planning and
tool model calls toward explicit per-turn/daily limits, cap tool iterations and
output sizes, and prevent unbounded autonomous loops. A budget pause resumes
without repeating completed effects. Logs contain operation IDs, durations,
counts, failure codes and usage, not credentials or document/chat contents.

## Savia Preview verification

The current browser is authenticated as Jose in tenant 12. The plugin iframe
fails while importing the signed entry module for version 1.8.6, before chat
renders. Inspect a freshly issued module request to distinguish expired grant,
artifact/installation mismatch, CORS/MIME failure and infrastructure failure.
Do not replace resources, reinstall unrelated versions or change credentials on
speculation. Fix the demonstrated cause, keeping SECOP domain code in SECOP.

## Acceptance and release

1. Deterministic tests prove correct tool selection and write authorization for
   advice, evaluation, plan creation, task creation and proposal requests.
2. Adversarial cases reject foreign owner/dossier/company/requirement IDs,
   document prompt injection, stale revisions and expired leases.
3. Replay, budget continuation and concurrency tests show no duplicate writes or
   loss of existing plans, tasks, files or reviewed evidence.
4. Fixtures cover missing company, expired evidence, unreviewed OCR, amendments,
   conflicting dates and budget-versus-quotation interpretation. Every claimed
   requirement/finding has a validated source; no unsupported "meets" result.
5. Existing Worker, infrastructure, bundle and security checks stay green.
6. Deploy through existing infrastructure, preserving resource IDs and secrets.
7. In Savia Preview, open saved CO1.REQ.10391118, ask for a complete preparation
   review, follow up on one requirement, reload and recover the saved plan, open
   a cited PDF, and verify task/draft actions. Use the selected real company only
   if one exists; report missing profile instead of fabricating test evidence.
8. Record UI and backend evidence separately. A backend-only test is not proof
   that Savia's complete user flow works.

## Scope exclusions

No new Savia-specific procurement backend, automatic offer submission, new OCR
provider, model training, arbitrary external browsing, credential changes or
storage replacement. This release does not promise legal certification or an
automatically complete company profile.
