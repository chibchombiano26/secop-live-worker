const RETRY_DELAYS_MS = [50, 150] as const;

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

/** Match only the transient D1 failure seen in production, never generic errors. */
export function isTransientD1NetworkLoss(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 3 && current && !visited.has(current); depth++) {
    visited.add(current);
    if (/\bnetwork connection lost\b/iu.test(errorMessage(current) ?? ""))
      return true;
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/** Retry a known transient D1 connection loss at most twice after the first attempt. */
export async function retryTransientD1<T>(operation: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientD1NetworkLoss(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
