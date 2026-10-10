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
