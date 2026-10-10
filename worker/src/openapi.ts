export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "SECOP Live Proxy",
    version: "1.0.0",
    description:
      "Live search over Colombia SECOP (datos.gov.co Socrata API). No database.",
  },
  paths: {
    "/health": {
      get: {
        summary: "Health",
        responses: { "200": { description: "ok" } },
      },
    },
    "/licitaciones": {
      get: {
        summary: "Search tenders live",
        parameters: [
          { name: "estado", in: "query", schema: { type: "string" } },
          { name: "entidad", in: "query", schema: { type: "string" } },
          { name: "modalidad", in: "query", schema: { type: "string" } },
          { name: "departamento", in: "query", schema: { type: "string" } },
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "desde", in: "query", schema: { type: "string" } },
          { name: "hasta", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
          { name: "offset", in: "query", schema: { type: "integer" } },
          { name: "fresh", in: "query", schema: { type: "boolean" } },
        ],
        responses: { "200": { description: "paged rows + next/prev" } },
      },
    },
    "/licitaciones/{id}": {
      get: {
        summary: "Tender detail by ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "rows" }, "404": { description: "not found" } },
      },
    },
    "/documentos/search": {
      get: {
        summary: "Search documents live",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string" } },
          { name: "entidad", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
          { name: "offset", in: "query", schema: { type: "integer" } },
          { name: "fresh", in: "query", schema: { type: "boolean" } },
        ],
        responses: { "200": { description: "paged rows + next/prev" } },
      },
    },
  },
} as const;

export function scalarHtml(openapiUrl: string): string {
  return `<!doctype html>
<html><head><title>SECOP Live Proxy</title><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/></head>
<body><div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
<script>Scalar.createApiReference('#app', { url: '${openapiUrl}' })</script>
</body></html>`;
}
