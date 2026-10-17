export type SecopCatalogField = "departamento" | "entidad" | "modalidad";

export interface SecopCatalogEnvelope {
  id: SecopCatalogField;
  values: string[];
  count: number;
  complete: true;
  updated_at: string;
}

export interface SecopCatalogCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

export interface SecopCatalogKV {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

export interface SecopCatalogDependencies {
  env: Record<string, unknown> & {
    SOCRATA_DOMAIN?: string;
    CATALOG_KV?: SecopCatalogKV;
  };
  socrataFetch(
    dataset: string,
    soql: string,
    env: Record<string, unknown>,
  ): Promise<unknown>;
  dataset: string;
  stringSchema(): unknown;
  cache?: SecopCatalogCache;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface SecopCatalogToolServer {
  registerTool(
    name: string,
    config: {
      description: string;
      inputSchema: { campo: unknown };
      annotations: {
        readOnlyHint: true;
        destructiveHint: false;
        openWorldHint: true;
      };
    },
    handler: (input: { campo: string }) => Promise<unknown>,
  ): unknown;
}

export function readSecopCatalog(
  campo: string,
  deps: SecopCatalogDependencies,
): Promise<SecopCatalogEnvelope>;

export function registerSecopCatalogTool(
  server: SecopCatalogToolServer,
  deps: SecopCatalogDependencies,
): void;
