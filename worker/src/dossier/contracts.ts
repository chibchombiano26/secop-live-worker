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
  | "workers_ai_shape"
  | "provider_error"
  | "output_truncated";
export type ModelProviderErrorType =
  | "context_length_exceeded"
  | "max_tokens_exceeded"
  | "token_limit_exceeded"
  | "string_too_long"
  | "authentication"
  | "permission_denied"
  | "payment_required"
  | "rate_limit_exceeded"
  | "provider_overloaded"
  | "provider_unavailable"
  | "invalid_request"
  | "invalid_prompt"
  | "not_found"
  | "precondition_failed"
  | "payload_too_large"
  | "unprocessable"
  | "content_policy_violation"
  | "refusal"
  | "invalid_image"
  | "image_too_large"
  | "image_too_small"
  | "unsupported_image_format"
  | "image_not_found"
  | "image_download_failed"
  | "server"
  | "timeout"
  | "unmapped";
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
export type ModelHttp403Cause =
  | "guardrail"
  | "key_limit"
  | "budget_limit"
  | "provider_policy"
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
  errorType?: ModelProviderErrorType;
  providerErrorCode?: number;
  http403Cause?: ModelHttp403Cause;
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
