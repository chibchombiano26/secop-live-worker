import { describe, expect, it, vi } from "vitest";
import { reviewJointRequirements } from "../src/dossier/joint-review";
import type { Requirement } from "../src/dossier/synthesis";

const req = (wording: string, documentVersionId: string): Requirement => ({
  wording,
  category: "documents",
  mandatory: true,
  lot: null,
  deadline: null,
  rule: null,
  citations: [
    { documentVersionId, page: 1, excerpt: `Evidence for ${wording}` },
  ],
});

function cache() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: unknown) => void values.set(key, value),
  };
}

describe("reviewJointRequirements", () => {
  it("preserves complete aggregate reviews larger than one model response", async () => {
    const requirements = Array.from({ length: 20 }, (_, i) =>
      req(`Requirement ${i}`, `doc-${i}`),
    );
    const candidates = requirements
      .flatMap((_, left) =>
        requirements.slice(left + 1).map((_, offset) => ({
          left,
          right: left + offset + 1,
          kind: "conflict" as const,
          reason: "Compare the original obligations.",
        })),
      )
      .slice(0, 150);
    const store = cache();
    let calls = 0;
    const model = {
      id: "large-complete-review",
      generate: async (input: any) => {
        calls++;
        return input.purpose === "joint_requirement_review"
          ? { summary: "Complete source comparison.", candidates }
          : {
              decision: "unconfirmed",
              reason: "Further source verification is required. ".repeat(30),
              citationIds: input.outputSchema.properties.citationIds.items.enum,
            };
      },
    };
    const result = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
    );
    expect(JSON.stringify(result).length).toBeGreaterThan(200_000);
    expect(result.candidateReviews).toHaveLength(150);
    expect(result.metrics.completedVerifications).toBe(150);
    expect(
      result.candidateReviews.map(({ left, right }) => [left, right]),
    ).toEqual(candidates.map(({ left, right }) => [left, right]));
    const completedCalls = calls;
    const resumed = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
    );
    expect(calls).toBe(completedCalls);
    expect(resumed.candidateReviews).toEqual(result.candidateReviews);
  });

  it("compares every requirement and uses original quotes to verify both sides", async () => {
    const requirements = [
      req("Entregar antes del 10 de mayo", "doc-a"),
      req("Entregar antes del 20 de mayo", "doc-b"),
      req("Adjuntar certificado", "doc-c"),
    ];
    const calls: Array<{ purpose: string; input: string }> = [];
    const model = {
      id: "fixture-model",
      generate: async (input: any) => {
        calls.push({ purpose: input.purpose, input: JSON.stringify(input) });
        if (input.purpose === "joint_requirement_review") {
          expect(input.context.requirements).toHaveLength(3);
          expect(input.context.requirements[0][0]).toBe(0);
          expect(input.context.requirements[0][1]).toBe(
            requirements[0].wording,
          );
          expect(input.context.requirements[0][7]).toEqual([0]);
          expect(JSON.stringify(input.context)).not.toContain("Evidence for");
          return {
            summary:
              "Hay dos fechas de entrega diferentes que requieren revisión.",
            candidates: [
              {
                left: 0,
                right: 1,
                kind: "conflict",
                reason: "Las fechas difieren.",
              },
            ],
          };
        }
        expect(input.evidence).toHaveLength(2);
        expect(input.outputSchema.properties.citationIds.items.enum).toEqual([
          "r0c0",
          "r1c0",
        ]);
        expect(input.evidence[0]).toMatchObject({
          documentVersionId: "doc-a",
          page: 1,
          text: "Evidence for Entregar antes del 10 de mayo",
        });
        expect(input.evidence[1]).toMatchObject({
          documentVersionId: "doc-b",
          page: 1,
          text: "Evidence for Entregar antes del 20 de mayo",
        });
        return {
          decision: "conflict",
          reason: "Las fuentes establecen fechas distintas.",
          citationIds: ["r0c0", "r1c0"],
        };
      },
    };
    const result = await reviewJointRequirements(
      requirements,
      model,
      { total: 3, pending: [], reviewRequired: [] },
      cache(),
    );
    expect(result.summaries).toEqual([
      "Hay dos fechas de entrega diferentes que requieren revisión.",
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain(
      "Conflicto verificado entre requisitos",
    );
    expect(result.metrics.verifiedCandidates).toBe(1);
    expect(result.metrics.completedVerifications).toBe(1);
    expect(result.metrics.maxRequestChars).toBe(
      Math.max(...calls.map((call) => call.input.length)),
    );
    expect(
      result.candidateReviews[0].citations.map(
        (citation) => citation.documentVersionId,
      ),
    ).toEqual(["doc-a", "doc-b"]);
    expect(result.metrics.requirements).toBe(3);
    expect(result.metrics.comparedPairs).toBe(3);
    expect(calls.map((call) => call.purpose)).toEqual([
      "joint_requirement_review",
      "joint_conflict_verification",
    ]);
  });

  it("keeps amendment direction and both original citations from verification", async () => {
    const model = {
      id: "amendment-model",
      generate: async (input: any) =>
        input.purpose === "joint_requirement_review"
          ? {
              summary: "Una modificación explícita requiere verificación.",
              candidates: [
                {
                  left: 0,
                  right: 1,
                  kind: "amendment",
                  reason:
                    "El segundo documento modifica expresamente el primero.",
                },
              ],
            }
          : {
              decision: "amendment",
              reason:
                "La cláusula posterior sustituye expresamente la anterior.",
              citationIds: ["r0c0", "r1c0"],
              changeExcerpt: "Se modifica el plazo a 20 días",
              previous: 0,
              replacement: 1,
            },
    };
    const result = await reviewJointRequirements(
      [
        req("Plazo inicial: 10 días", "doc-a"),
        req("Se modifica el plazo a 20 días", "doc-b"),
      ],
      model,
      {},
      cache(),
    );
    expect(result.amendments).toEqual([
      expect.objectContaining({
        previous: 0,
        replacement: 1,
        citations: [
          expect.objectContaining({ documentVersionId: "doc-a" }),
          expect.objectContaining({ documentVersionId: "doc-b" }),
        ],
      }),
    ]);
  });

  it("does not treat compatible extra detail as an amendment without an explicit source change", async () => {
    const result = await reviewJointRequirements(
      [
        req("Constituir garantía", "a"),
        req("Constituir garantía única en los términos del contrato", "b"),
      ],
      {
        id: "compatible",
        generate: async (input: any) =>
          input.purpose === "joint_requirement_review"
            ? {
                summary: "Garantías.",
                candidates: [
                  {
                    left: 0,
                    right: 1,
                    kind: "amendment",
                    reason: "Más detalles",
                  },
                ],
              }
            : {
                decision: "amendment",
                reason: "Agrega detalles",
                citationIds: ["r0c0", "r1c0"],
                previous: 0,
                replacement: 1,
              },
      },
      {},
      cache(),
    );
    expect(result.amendments).toEqual([]);
    expect(result.candidateReviews[0].decision).toBe("unconfirmed");
  });

  it("keeps pending and review-required document coverage in the comparison request", async () => {
    const coverage = {
      total: 2,
      indexed: 1,
      pending: [{ id: "pending-doc", name: "Anexo", state: "pending" }],
      reviewRequired: ["scan-doc"],
    };
    let seen: unknown;
    await reviewJointRequirements(
      [req("Requisito completo", "doc-a")],
      {
        id: "coverage-model",
        generate: async (input: any) => {
          seen = input.context.coverage;
          return { summary: "La cobertura sigue parcial.", candidates: [] };
        },
      },
      coverage,
      cache(),
    );
    expect(seen).toEqual(coverage);
  });

  it("places every pair together across bounded groups without clipping the final requirement", async () => {
    const requirements = Array.from({ length: 14 }, (_, i) =>
      req(`Requisito final ${i}: ${String(i).repeat(3_750)}`, `doc-${i}`),
    );
    const observed = new Set<string>();
    const reviewInputs: any[] = [];
    let active = 0,
      maximum = 0;
    const model = {
      id: "pair-coverage-model",
      generate: async (input: any) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        if (input.purpose === "joint_requirement_review") {
          reviewInputs.push(input);
          const indices = input.context.requirements.map(
            (row: any[]) => row[0],
          );
          for (let left = 0; left < indices.length; left++)
            for (let right = left + 1; right < indices.length; right++)
              observed.add(
                `${Math.min(indices[left], indices[right])}:${Math.max(indices[left], indices[right])}`,
              );
        }
        return { summary: "Revisión agrupada.", candidates: [] };
      },
    };
    const result = await reviewJointRequirements(
      requirements,
      model,
      {},
      cache(),
    );
    expect(result.metrics.blocks).toBeGreaterThan(1);
    expect(maximum).toBe(Math.min(8, result.metrics.reviewGroups));
    expect(result.metrics.requirements).toBe(14);
    expect(observed.size).toBe((14 * 13) / 2);
    expect(observed.has("0:13")).toBe(true);
    expect(observed.has("12:13")).toBe(true);
    const allIndices = requirements.map((_, index) => index);
    const canUse = (index: number, bounds: any) =>
      Number.isInteger(bounds.minimum) &&
      Number.isInteger(bounds.maximum) &&
      index >= bounds.minimum &&
      index <= bounds.maximum;
    for (const input of reviewInputs) {
      const indices = input.context.requirements.map((row: any[]) => row[0]);
      const properties =
        input.outputSchema.properties.candidates.items.properties;
      const left = properties.left;
      const right = properties.right;
      expect(Number.isInteger(left.minimum)).toBe(true);
      expect(Number.isInteger(left.maximum)).toBe(true);
      expect(Number.isInteger(right.minimum)).toBe(true);
      expect(Number.isInteger(right.maximum)).toBe(true);
      for (const index of allIndices) {
        if (canUse(index, left) || canUse(index, right))
          expect(indices).toContain(index);
      }
      const overlap =
        left.minimum <= right.maximum && right.minimum <= left.maximum;
      const sameBounds =
        left.minimum === right.minimum && left.maximum === right.maximum;
      expect(overlap === sameBounds).toBe(true);
    }
    for (let left = 0; left < allIndices.length; left++) {
      for (let right = left + 1; right < allIndices.length; right++) {
        const reachable = reviewInputs.some((input) => {
          const indices = input.context.requirements.map(
            (row: any[]) => row[0],
          );
          const properties =
            input.outputSchema.properties.candidates.items.properties;
          return (
            indices.includes(left) &&
            indices.includes(right) &&
            ((canUse(left, properties.left) &&
              canUse(right, properties.right)) ||
              (canUse(right, properties.left) &&
                canUse(left, properties.right)))
          );
        });
        expect(reachable).toBe(true);
      }
    }
  });

  it("rejects invented citation IDs and never caches malformed model output", async () => {
    const store = cache();
    const model = {
      id: "bad-citation-model",
      generate: async (input: any) =>
        input.purpose === "joint_requirement_review"
          ? {
              summary: "Revisión.",
              candidates: [
                { left: 0, right: 1, kind: "conflict", reason: "Difieren." },
              ],
            }
          : {
              decision: "conflict",
              reason: "No demostrado.",
              citationIds: ["invented"],
            },
    };
    await expect(
      reviewJointRequirements(
        [req("A", "doc-a"), req("B", "doc-b")],
        model,
        {},
        store,
      ),
    ).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
    // The valid comparison result is reusable; the invalid verification is not.
    expect(store.values.size).toBe(1);
  });

  it("logs only schema paths and issue types for uncached invalid group output", async () => {
    const sensitiveValue = "private model response text";
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    try {
      await expect(
        reviewJointRequirements(
          [req("A", "doc-a")],
          {
            id: "invalid-group-schema",
            generate: async () => ({
              summary: `${sensitiveValue}${"x".repeat(6_000)}`,
              candidates: [],
            }),
          },
          {},
          cache(),
        ),
      ).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
      expect(logs).toHaveLength(1);
      const event = JSON.parse(logs[0]);
      expect(event).toMatchObject({
        event: "joint_review_invalid_output",
        groupIndex: 0,
        category: "schema",
      });
      expect(event.issues).toEqual([
        { path: ["summary"], type: expect.any(String) },
      ]);
      expect(logs[0]).not.toContain(sensitiveValue);
      expect(logs[0]).not.toContain("message");
      expect(logs[0]).not.toContain("value");
    } finally {
      spy.mockRestore();
    }
  });

  it("logs candidate scope numbers without requirement or model text", async () => {
    const sensitiveValue = "do not log this candidate explanation";
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    try {
      await expect(
        reviewJointRequirements(
          [req("A", "doc-a"), req("B", "doc-b")],
          {
            id: "invalid-group-scope",
            generate: async () => ({
              summary: "Revisión.",
              candidates: [
                {
                  left: 0,
                  right: 99,
                  kind: "conflict",
                  reason: sensitiveValue,
                },
              ],
            }),
          },
          {},
          cache(),
        ),
      ).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0])).toEqual({
        event: "joint_review_invalid_output",
        groupIndex: 0,
        category: "candidate_scope",
        left: 0,
        right: 99,
        allowedIndexMin: 0,
        allowedIndexMax: 1,
        allowedIndexCount: 2,
      });
      expect(logs[0]).not.toContain(sensitiveValue);
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies a self-comparison separately from an out-of-scope candidate", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    try {
      await expect(
        reviewJointRequirements(
          [req("A", "doc-a")],
          {
            id: "invalid-group-self-pair",
            generate: async () => ({
              summary: "Revisión.",
              candidates: [
                {
                  left: 0,
                  right: 0,
                  kind: "conflict",
                  reason: "Difieren.",
                },
              ],
            }),
          },
          {},
          cache(),
        ),
      ).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
      expect(JSON.parse(logs[0])).toMatchObject({
        event: "joint_review_invalid_output",
        category: "candidate_self",
        left: 0,
        right: 0,
        allowedIndexMin: 0,
        allowedIndexMax: 0,
        allowedIndexCount: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("counts completed but unconfirmed candidates separately from confirmed candidates", async () => {
    const result = await reviewJointRequirements(
      [req("A", "doc-a"), req("B", "doc-b")],
      {
        id: "unconfirmed-model",
        generate: async (input: any) =>
          input.purpose === "joint_requirement_review"
            ? {
                summary: "Verificación necesaria.",
                candidates: [
                  {
                    left: 0,
                    right: 1,
                    kind: "conflict",
                    reason: "La formulación puede diferir.",
                  },
                ],
              }
            : {
                decision: "unconfirmed",
                reason: "La evidencia no resuelve la diferencia.",
                citationIds: [],
              },
      },
      {},
      cache(),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.candidateReviews[0].decision).toBe("unconfirmed");
    expect(result.metrics.verifiedCandidates).toBe(0);
    expect(result.metrics.completedVerifications).toBe(1);
  });

  it("verifies candidates with at most eight workers and merges in candidate order", async () => {
    const requirements = Array.from({ length: 11 }, (_, i) =>
      req(`Requisito ${i}`, `doc-${i}`),
    );
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      left: i,
      right: (i + 1) % requirements.length,
      kind: "conflict" as const,
      reason: `Propuesta ${i}`,
    }));
    let activeVerifications = 0;
    let maximumVerifications = 0;
    let activeReviews = 0;
    let phaseOverlap = false;
    const progress: number[] = [];
    const result = await reviewJointRequirements(
      requirements,
      {
        id: "parallel-candidate-verification",
        generate: async (input: any) => {
          if (input.purpose === "joint_requirement_review") {
            activeReviews++;
            if (activeVerifications > 0) phaseOverlap = true;
            const value = {
              summary: "Revisión completa.",
              candidates,
            };
            activeReviews--;
            return value;
          }
          activeVerifications++;
          maximumVerifications = Math.max(
            maximumVerifications,
            activeVerifications,
          );
          if (activeReviews > 0) phaseOverlap = true;
          const pairIndex = input.context.candidate.left;
          await new Promise((resolve) =>
            setTimeout(resolve, (candidates.length - pairIndex) * 2),
          );
          activeVerifications--;
          return {
            decision: "unconfirmed",
            reason: `Pendiente ${pairIndex}`,
            citationIds: [],
          };
        },
      },
      {},
      cache(),
      async (update) => {
        if (update.phase === "joint_verification")
          progress.push(update.candidatesCompleted as number);
      },
    );

    expect(maximumVerifications).toBe(8);
    expect(phaseOverlap).toBe(false);
    expect(
      result.candidateReviews.map(({ left, right }) => [left, right]),
    ).toEqual(candidates.map(({ left, right }) => [left, right]));
    expect(result.candidateReviews.map(({ reason }) => reason)).toEqual(
      candidates.map((_, index) => `Pendiente ${index}`),
    );
    expect(progress).toEqual(Array.from({ length: 11 }, (_, index) => index));
  });

  it("settles candidate verification caches after failure and reuses successes", async () => {
    const requirements = Array.from({ length: 11 }, (_, i) =>
      req(`Requisito ${i}`, `doc-${i}`),
    );
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      left: i,
      right: i + 1,
      kind: "conflict" as const,
      reason: `Propuesta ${i}`,
    }));
    const store = cache();
    const successfulPairs = new Set<number>();
    const repeatedSuccessfulPairs: number[] = [];
    let failFirstPair = true;
    let verificationCalls = 0;
    const model = {
      id: "parallel-verification-resume",
      generate: async (input: any) => {
        if (input.purpose === "joint_requirement_review")
          return { summary: "Revisión completa.", candidates };
        const left = input.context.candidate.left as number;
        verificationCalls++;
        if (left === 0 && failFirstPair) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          throw new Error("temporary verification failure");
        }
        if (successfulPairs.has(left)) repeatedSuccessfulPairs.push(left);
        await new Promise((resolve) => setTimeout(resolve, 10));
        successfulPairs.add(left);
        return {
          decision: "unconfirmed",
          reason: `Pendiente ${left}`,
          citationIds: [],
        };
      },
    };

    await expect(
      reviewJointRequirements(requirements, model, {}, store),
    ).rejects.toThrow("temporary verification failure");
    expect(verificationCalls).toBe(8);
    expect(successfulPairs.size).toBe(7);
    expect(store.values.size).toBe(8); // One group and seven verification results.

    failFirstPair = false;
    const resumed = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
    );
    expect(verificationCalls).toBe(11);
    expect(successfulPairs.size).toBe(10);
    expect(repeatedSuccessfulPairs).toEqual([]);
    expect(resumed.candidateReviews.map(({ left }) => left)).toEqual(
      candidates.map(({ left }) => left),
    );
  });

  it("resumes cached completed review groups without repeating model calls", async () => {
    const requirements = Array.from({ length: 12 }, (_, i) =>
      req(
        `Requisito ${i}: ${"texto completo y conservado. ".repeat(55)}`,
        `doc-${i}`,
      ),
    );
    const store = cache();
    const purposes: string[] = [];
    const model = {
      id: "resume-model",
      generate: async (input: any) => {
        purposes.push(input.purpose);
        return { summary: "Revisión del bloque.", candidates: [] };
      },
    };
    let failed = false;
    await expect(
      reviewJointRequirements(
        requirements,
        model,
        {},
        store,
        async (progress) => {
          if (!failed && progress.reviewGroupsCompleted === 1) {
            failed = true;
            throw new Error("interrupted");
          }
        },
      ),
    ).rejects.toThrow("interrupted");
    const before = purposes.length;
    const resumed = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
    );
    expect(resumed.metrics.reviewGroups).toBe(1);
    expect(purposes.length).toBe(before);
  });

  it("settles in-flight review caches on failure and reuses them on the next attempt", async () => {
    const requirements = Array.from({ length: 24 }, (_, i) =>
      req(`Requirement ${i}: ${"complete evidence ".repeat(180)}`, `doc-${i}`),
    );
    const store = cache();
    let failing = true;
    let calls = 0;
    const successfulGroups = new Set<string>();
    const repeatedGroups: string[] = [];
    const model = {
      id: "parallel-resume",
      generate: async (input: any) => {
        const group = JSON.stringify(
          input.context.requirements.map((r: any[]) => r[0]),
        );
        const call = ++calls;
        if (successfulGroups.has(group)) repeatedGroups.push(group);
        if (failing && call === 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          throw new Error("temporary inference failure");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        successfulGroups.add(group);
        return { summary: "Completed group", candidates: [] };
      },
    };
    await expect(
      reviewJointRequirements(requirements, model, {}, store),
    ).rejects.toThrow("temporary inference failure");
    expect(calls).toBe(8);
    expect(store.values.size).toBe(7);
    failing = false;
    const resumed = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
    );
    expect(repeatedGroups).toEqual([]);
    expect(resumed.metrics.comparedPairs).toBe((24 * 23) / 2);
    expect(successfulGroups.size).toBe(resumed.metrics.reviewGroups);
  });

  it("rejects a single requirement that cannot fit without truncating its wording", async () => {
    const huge = req("X".repeat(49_000), "doc-a");
    let called = false;
    await expect(
      reviewJointRequirements(
        [huge],
        {
          id: "oversized-model",
          generate: async () => {
            called = true;
            return { summary: "", candidates: [] };
          },
        },
        {},
        cache(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_CONTEXT_LIMIT" });
    expect(called).toBe(false);
  });
});
