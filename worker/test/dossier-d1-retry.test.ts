import { describe, expect, it } from "vitest";
import { retryTransientD1 } from "../src/dossier/d1-retry";

describe("transient D1 retry", () => {
  it("stops after three physical attempts and preserves the final D1 error", async () => {
    let attempts = 0;
    const failure = new Error("D1_ERROR: Network connection lost");

    await expect(
      retryTransientD1(async () => {
        attempts++;
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(attempts).toBe(3);
  });

  it("retries a transient error supplied as a nested cause", async () => {
    let attempts = 0;

    await expect(
      retryTransientD1(async () => {
        attempts++;
        if (attempts === 1)
          throw new Error("operation failed", {
            cause: new Error("Network connection lost"),
          });
        return "ok";
      }),
    ).resolves.toBe("ok");

    expect(attempts).toBe(2);
  });
});
