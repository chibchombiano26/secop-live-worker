import { z } from "zod/v4";
export const PRIVATE_SCOPES = [
  "dossier:read",
  "dossier:write",
  "company:write",
  "conversation:write",
] as const;
export const scopeSchema = z.enum(PRIVATE_SCOPES);
export const privateContextSchema = z
  .object({
    ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    scopes: z.array(scopeSchema).min(1),
  })
  .strict();
export type PrivateContext = z.infer<typeof privateContextSchema>;
export type ModelInvalidOutputPhase =
  | "provider_envelope_json"
  | "missing_content"
  | "content_json"
  | "workers_ai_shape";
export type ModelProviderLabel =
  | "Workers AI"
  | "OpenRouter"
  | "Groq"
  | "Cerebras"
  | "DeepInfra"
  | "Near AI"
  | "CoreWeave"
  | "Baseten"
  | "Together"
  | "Fireworks"
  | "Novita"
  | "Google"
  | "Amazon Bedrock"
  | "Azure"
  | "Hyperbolic"
  | "SiliconFlow"
  | "Nebius"
  | "Inference.net"
  | "unknown";
export type ModelErrorDiagnostic = {
  provider: ModelProviderLabel;
  phase: ModelInvalidOutputPhase;
  elapsedMs: number;
  shape?: {
    contentType?:
      "application/json" | "text/plain" | "other" | "unknown" | "workers_ai";
    length?: number;
  };
  finishReason?:
    "length" | "stop" | "tool_calls" | "error" | "content_filter" | "other";
  providerErrorCode?: number;
};
export class DossierError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public retryable = false,
    public diagnostic?: ModelErrorDiagnostic,
  ) {
    super(code);
    this.name = "DossierError";
  }
}
export type PrivateAuthEnv = {
  PRIVATE_AUTH_PEPPER?: string;
  PRIVATE_CONNECTIONS?: string;
};
