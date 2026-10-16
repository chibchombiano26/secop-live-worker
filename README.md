# SECOP Live Worker (Cloudflare) + OpenTofu multi-provider

TypeScript Cloudflare Worker mirroring `secop-live`: live Socrata search,
TTL cache (Cache API), API-key auth, Scalar docs, MCP (Streamable HTTP).
Deployed with **OpenTofu** to **Cloudflare** and/or **Docker**.

## Layout

```
worker/          TS worker (REST /licitaciones, /documentos/search,
                 /scalar, /openapi.json, /mcp)
worker/test/     vitest unit tests (no network)
tofu/            versions/variables/main + modules/{worker,docker}
```

## Develop

```bash
cd worker && npm install
npm test && npm run typecheck
npx wrangler dev   # local smoke (no account needed)
```

## Deploy with OpenTofu

```bash
cd tofu
cp dev.tfvars.example dev.auto.tfvars   # fill secrets (never commit)
npm run bundle --prefix ../worker       # dist/bundle.js for the provider
docker run --rm -v "$PWD:/tofu" -w /tofu ghcr.io/opentofu/opentofu:latest init
# Cloudflare only:
docker run --rm -v "$PWD:/tofu" -w /tofu ghcr.io/opentofu/opentofu:latest \
  apply -var-file=dev.auto.tfvars -target=module.worker
# Docker version (secop-live GHCR image, local daemon):
docker run --rm -v "$PWD:/tofu" -v /var/run/docker.sock:/var/run/docker.sock \
  -w /tofu ghcr.io/opentofu/opentofu:latest \
  apply -var-file=dev.auto.tfvars -target=module.docker
```

Cloudflare needs: API token (Workers edit) + account ID (`CLOUDFLARE_*` vars).
Optional `custom_hostname` (+ `cloudflare_zone_id`) for your domain.
Docker needs: local daemon + published image (auto-published from
`secop-live` repo to GHCR on every main push).

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

Originals are retained until explicitly removed unless
`ORIGINAL_RETENTION_DAYS` is configured (1–3650). That option expires originals
only, preserving extracted evidence, reports and audit history. The explicit
company-evidence deletion operation additionally redacts the extraction and marks
company evaluations stale; existing reports/conversations may retain quotations.
Its API requires `confirmed:true`; explain this impact before requesting it.

For complete, cached cross-document synthesis, see [joint dossier analysis](docs/guides/joint-analysis.md).
