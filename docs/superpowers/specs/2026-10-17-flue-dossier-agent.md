# SECOP Flue dossier agent

## Accepted scope

Run one durable Flue agent per authenticated owner and dossier in the SECOP Worker.
Keep Savia's existing assistant protocol, history, proposal and source actions.
Use Cloudflare Workflows for long-running processing. Reuse existing D1, R2,
Vectorize, OCR, grounded-answer and exhaustive-coverage functions.

## Boundaries

The agent identity is a hash of a versioned tuple of owner and dossier. Immutable
initial data must match that identity. The current delivery carries a server-issued
job ID and lease; tools re-read that job under its owner and validate its dossier
and selected company before doing work. No public Flue conversation routes, shell,
MCP connections, arbitrary source selectors or automatic submission capabilities.

The initial tools inspect the scoped dossier and execute its saved study request.
The existing citation/coverage validation persists the authoritative answer for
Savia; free-form agent acknowledgement is never treated as evidence or compliance.
Disable trace content and provider request logging where applicable.

## Durability

Queue delivery creates a deterministic Workflow instance for the saved job attempt.
Workflows checkpoint claim, dispatch receipt, reply read and completion separately.
Retries re-attach to an admitted submission. Existing D1 leases, checkpoints,
model limits, idempotency keys and queued recovery remain authoritative.

## Deployment

Build the same SECOP Worker using Flue's official Vite integration, keeping its
existing HTTP/OAuth, queue and scheduled handlers. Add an append-only SQLite
Durable Object migration and a Workflow binding. The unified deployment must
preserve existing resource IDs, secrets and record counts, reconcile the Workflow,
and reject binding/migration drift. Do not recreate existing storage or OCR.

## Acceptance

- Existing tests pass and CI remains green.
- Adversarial tests reject another owner, dossier, company and stale lease.
- A duplicate queue delivery does not duplicate execution; retries retain progress.
- A saved Savia Preview dossier can chat through the agent with valid source citations.
- Live evidence identifies the scoped agent and Workflow without exposing secrets.
