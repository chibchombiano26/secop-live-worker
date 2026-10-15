import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  routeContract,
  executePrivateOperation,
  type PrivateServiceEnv,
} from "./api";
import { DossierError } from "./contracts";
import {
  requirePrivateContext,
  assertPrivateOwnerActive,
} from "./authorization";
export function registerDossierTools(
  server: McpServer,
  env: PrivateServiceEnv,
  verifiedGrant: unknown,
  origin: string,
) {
  for (const [name, route] of Object.entries(routeContract)) {
    server.registerTool(
      route.tool,
      {
        description: `Private SECOP dossier operation ${name}. Requires ${route.scope}. Input follows /private/openapi.json.`,
        inputSchema: { input: z.record(z.string(), z.unknown()) },
        annotations: {
          readOnlyHint: route.method === "GET",
          destructiveHint: name === "delete-document",
          openWorldHint: true,
        },
      },
      async ({ input }) => {
        try {
          const context = requirePrivateContext(verifiedGrant, route.scope);
          assertPrivateOwnerActive(env, context, route.scope);
          const data = await executePrivateOperation(
            env,
            context,
            name as keyof typeof routeContract,
            input,
            origin,
          );
          const output = { data };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (e) {
          const error =
            e instanceof DossierError
              ? e
              : new DossierError("INVALID_REQUEST", 422);
          const result = {
            error: { code: error.code, retryable: error.retryable },
          };
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        }
      },
    );
  }
}
