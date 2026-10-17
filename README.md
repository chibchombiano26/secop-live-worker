# SECOP Live Worker (Cloudflare) + OpenTofu multi-provider

TypeScript Cloudflare Worker mirroring `secop-live`: live Socrata search,
TTL cache (Cache API), API-key auth, Scalar docs, MCP (Streamable HTTP).
Live infrastructure is adopted with **OpenTofu**, Vectorize API reconciliation
and **Wrangler** for private OCR containers through one deployment command.

## Layout

```
worker/          TS worker (REST /licitaciones, /documentos/search,
                 /scalar, /openapi.json, /mcp)
worker/test/     vitest unit tests (no network)
infra/           production inventory, unified plan/deploy/check, safety tests
tofu/live/       protected imports of the existing live persistent resources
tofu/            historical sandbox/Docker scaffold
ocr/            private Cloudflare CPU OCR Worker and container
```

## License and contribution security

Licensed under [AGPL-3.0-only](LICENSE). Before contributing, run
`npm run security:setup` to enable secret scanning hooks. See
[repository security](docs/guides/repository-security.md) and [SECURITY.md](SECURITY.md).

## Develop

```bash
cd worker && npm install
npm test && npm run typecheck
npm run dev        # Wrangler runs the custom PDF.js-aware bundle step first
```

## Deploy the existing live service

```sh
npm ci --prefix worker
npm run infra:plan
npm run infra:deploy
npm run infra:check
```

The production inventory pins the existing D1, R2, KV, queues, Vectorize and OCR
identities. Deployment imports existing resources, preserves secrets, stores
private recovery copies in R2 and verifies data counts afterwards. It never
recreates missing storage. See [infrastructure and recovery](docs/guides/infrastructure.md)
for prerequisites, permissions, state handling and the manual GitHub workflow.

The historical `tofu/` root is a fresh/sandbox/Docker scaffold, **not the live
service configuration**. Production uses `tofu/live/` through the commands above.

## Endpoints (same contract as secop-live)

- `GET /licitaciones?...` (+ `next`/`prev`, `"cached"`, `?fresh=1`)
- `GET /licitaciones/{id}`, `GET /documentos/search?q=...`
- `GET /scalar`, `GET /openapi.json`, `GET /health` (open)
- `POST /mcp` (MCP Streamable HTTP, tools: buscar_licitaciones,
  detalle_licitacion, buscar_documentos; API key enforced)

## OAuth (so ChatGPT web can connect)

The Worker is also an OAuth 2.1 authorization server
(`@cloudflare/workers-oauth-provider`, KV-backed): discovery docs,
DCR (`/oauth/register`, CIMD supported), `/authorize` (approve with your
API key as access code), `/oauth/token` (+ refresh). ChatGPT path:
Plugins → Add custom MCP server → worker URL → OAuth → approve.

Public MCP compatibility includes `opciones_licitaciones` (complete cached catalogs)
and `documentos_licitacion` (verified tender/portfolio document association).
The maintained adapters live in `worker/src/public/`; do not patch built bundles.

The tender filters `estado`, `entidad`, `modalidad`, and `departamento` accept
either one value or repeated query parameters (up to 20 values of 500 characters,
ORed within a filter and ANDed across filters), for example
`/licitaciones?estado=Publicado&estado=Abierto&departamento=Antioquia`.

## Private connection isolation

Private capabilities require separate per-owner credentials, never public API keys.
`PRIVATE_AUTH_PEPPER` is a server secret of at least 32 characters.
`PRIVATE_CONNECTIONS` is a secret JSON array of `{ownerId, codeDigest, tokenDigest,
scopes, expiresAt?}` records. Digests are HMAC-SHA256 over `code:<value>` or
`token:<value>` using the pepper; never store raw codes or bearer tokens here.
Bind a dedicated owner/credential to exactly one Savia workspace connection.
Reuse that owner on reconnect; remove its entry to revoke credentials.
Private scopes are `dossier:read`, `dossier:write`, `company:write`, and
`conversation:write`. Old `mcp:read` grants keep public reads only; new scopes
require a fresh explicit consent. OAuth approval fails if no valid code is
configured. Public unauthenticated REST development behavior is unchanged.

Private records use owner-scoped versioned D1 entities and R2 keys. Apply
`worker/migrations/0001_dossiers.sql` before enabling private tools.
Dossier infrastructure is opt-in (`enable_dossiers=true` in OpenTofu).
The `dossier_secrets` map carries server-owned private/provider configuration.
The optional Docker target remains a public proxy; private features require the
Worker bindings and never fall back to in-memory persistence. Local integration
tests use real Miniflare D1/R2. Durable queued jobs use leases and a persisted
outbox; scheduled reconciliation redispatches missed or expired work each minute.

The native dossier chat opens cited stored PDFs through the worker-owned
`GET /private/source/{ticket}/view` page. It serves a self-hosted, pinned PDF.js
viewer and fixed versioned assets under `/private/source-assets/`; original files
remain available as downloads at `GET /private/source/{ticket}`. Tickets are
owner- and dossier-bound, expire after ten minutes, and viewer responses are
private/no-store with a restrictive same-origin policy. Versioned viewer assets
use immutable caching; no PDF is sent to a third-party viewer or CDN.

The native assistant provider advertises a `proposal-docx` document action for
the selected tender when its report is current. Its `generate-document` request
rechecks the current complete tender report and returns an editable Spanish
DOCX draft. The draft includes the full saved requirement ledger and source
excerpts, and, when selected, the current company profile and its evidence
excerpts. Without a selected profile it leaves explicit proponent placeholders.
It also includes response prompts, review warnings and non-certification
language. It does not
assert compliance or submit anything. Oversized source material and stale or
missing reports fail explicitly; the download is an owner-, tender- and
company-revision-bound private ticket that expires after ten minutes and is
served with attachment, no-store and content-sniffing protections.
Requirement and document records are loaded in bounded, owner-scoped batches
so large dossiers avoid sequential database round trips. Requested order and
all dossier/revision checks are preserved; missing required records fail explicitly.

### Extraction providers

For an optional private CPU OCR fallback on Cloudflare Containers, see
[the CPU OCR guide](docs/guides/cpu-ocr.md). Bind `SECOP_OCR` to the deployed
OCR Worker; native readable PDFs do not invoke OCR.

Set `EXTRACTOR_URL` (HTTPS) and secret `EXTRACTOR_KEY` for an OCR-capable service.
It receives multipart `file` and JSON `options` and must return
`{parserVersion, pages:[{page?,section?,text}], warnings:[], complete:true}`.
Partial or unreadable responses never become complete analyses. Alternatively,
attach a Cloudflare AI binding for `toMarkdown`; this adapter explicitly marks
its results as requiring source/OCR review. It supports parser-provided page
headings and section references without inventing pages. See
https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/.

ZIP inventories are checked for traversal, entry count, expanded size and nesting
before extraction. The default limits are 100 entries, 100 MiB expanded and one
nested archive. Uploaded originals stay private in R2; one-use, 10-minute upload
tickets associate replacements with blocked items. Protected upload pages keep
tickets in URL fragments and remove them from history before posting bytes.

Requirement extraction constrains generated citations to known source identities,
parser pages and exact source excerpt choices. Runtime citation validation still
rejects changed wording and restores only original whitespace. Valid cached
fragments survive job retries. Chat uses the same source-constrained citation
choices and budgets the combined evidence/schema context; any omitted retrieval
sources are explicit in model context. Failed chat reservations can be retried
with the same request identity without conflicting with their own cleanup;
stale requests after another committed turn remain rejected.

Optional [hybrid retrieval](docs/guides/hybrid-retrieval.md) combines local
lexical ranking with BGE-M3 embeddings and a separate `DOSSIER_VECTORS` index.
Every vector query is constrained to the authenticated owner, tender, and
current corpus generation. Returned IDs are resolved against canonical source
records before any text reaches the model. Lazy indexing is checkpointed and
bounded; unavailable or not-yet-visible vectors are reported as degraded lexical
retrieval. Embedding calls have a separate daily owner budget. Chat records
retain retrieval coverage, and obsolete report summaries and conversation turns
are excluded from the current model context.

Model calls use `MODEL_NAME` and either Cloudflare AI (`@cf/...`) or a fixed
HTTPS OpenAI-compatible `MODEL_URL` with secret `MODEL_KEY`. Set
`AI_PROVIDER_LABEL` to identify the processor on the consent screen. Defaults
limit each processing attempt to 64 model calls and 10 minutes, each owner to
1,000 calls/day, 30 write operations/minute and 240 reads/minute. Raise limits
only through server configuration (`MODEL_MAX_CALLS`, `MODEL_DAILY_LIMIT`).
Budget exhaustion is visible; stored extraction/review checkpoints are reusable.

Native assistant citations expose `canOpen` only for original PDFs still stored
for that owner and tender. The `open-source` assistant request creates a
single-purpose, 10-minute read ticket for the exact cited file; its private URL
serves the PDF inline with no-store and browser content-sniffing protections.
The ticket does not fetch public URLs or change dossier records.

Originals are retained until explicitly removed unless
`ORIGINAL_RETENTION_DAYS` is configured (1–3650). That option expires originals
only, preserving extracted evidence, reports and audit history. The explicit
company-evidence deletion operation additionally redacts the extraction and marks
company evaluations stale; existing reports/conversations may retain quotations.
Its API requires `confirmed:true`; explain this impact before requesting it.

For complete, cached cross-document synthesis, see [joint dossier analysis](docs/guides/joint-analysis.md).

Generated proposal ticket downloads support credential-free browser fetches so Savia can import the DOCX into its private Office suite. The URL remains short-lived and bound to the owner and current dossier/company revisions; CORS does not authorize ticket creation or bypass these checks. Savia stores the imported copy and subsequent editor revisions in its existing R2 document storage.

## Current tender search

Use `vigentes=true` on `/licitaciones` or the boolean MCP argument to search
future Colombian reception deadlines, excluding terminal, evaluation, draft
and suspended states. Filtering occurs before pagination; results are ordered
by nearest deadline. Undated records are excluded. Active REST responses bypass
the historical response cache so an elapsed deadline is not reused. Omit the
flag or use false to retain full-history search. This scope does not establish
that a bidder is eligible.

Catalog MCP reads return a validated stored complete snapshot immediately when
stale and refresh it through the request execution context in the background.
The scheduled handler warms all three catalogs so users do not depend on cold
Socrata group queries. Incomplete catalogs are never advertised as complete.
