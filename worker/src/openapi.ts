const multiSelectParameter = (name: string) => ({
  name,
  in: "query",
  description: "May be supplied once as a string or repeated up to 20 times for OR matching within this filter; separate filters are ANDed.",
  style: "form",
  explode: true,
  schema: {
    oneOf: [
      { type: "string", minLength: 1, maxLength: 500 },
      {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 500 },
      },
    ],
  },
});

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
          multiSelectParameter("estado"),
          multiSelectParameter("entidad"),
          multiSelectParameter("modalidad"),
          multiSelectParameter("departamento"),
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "desde", in: "query", schema: { type: "string" } },
          { name: "hasta", in: "query", schema: { type: "string" } },
          {
            name: "vigentes",
            in: "query",
            description: "When true, requires a future Colombian local reception timestamp and excludes terminal tender states; results are ordered by nearest deadline.",
            schema: { type: "boolean", default: false },
          },
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
