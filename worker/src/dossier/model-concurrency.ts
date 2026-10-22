import { DossierError } from "./contracts";

export const DEFAULT_MODEL_EXTRACTION_CONCURRENCY = 8;
export const MAX_MODEL_EXTRACTION_CONCURRENCY = 16;

export function modelExtractionConcurrency(value?: string | number): number {
  if (value === undefined) return DEFAULT_MODEL_EXTRACTION_CONCURRENCY;
  const concurrency = Number(value);
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_MODEL_EXTRACTION_CONCURRENCY
  )
    throw new DossierError("MODEL_BUDGET_UNCONFIGURED", 503);
  return concurrency;
}
