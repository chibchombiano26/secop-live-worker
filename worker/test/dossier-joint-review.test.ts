import { describe, expect, it, vi } from "vitest";
import { reviewJointRequirements } from "../src/dossier/joint-review";
import { DossierError } from "../src/dossier/contracts";
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

function unconfirmedBatch(input: any) {
  if (input.purpose !== "joint_conflict_verification_batch") return null;
  return {
    results: input.context.tasks.map((task: any) => ({
      taskId: task.taskId,
      decision: "unconfirmed",
      reason: `Pendiente ${task.candidate.left}:${task.candidate.right}. ${"Further source verification is required. ".repeat(35)}`,
      citationIds: [],
    })),
  };
}

describe("reviewJointRequirements", () => {
  it("batches candidate verifications while preserving every result in pair order", async () => {
    const requirements = Array.from({ length: 10 }, (_, index) =>
      req(`Requirement ${index}`, `doc-${index}`),
    );
    const candidates = requirements.flatMap((_, left) =>
      requirements.slice(left + 1).map((_, offset) => ({
        left,
        right: left + offset + 1,
        kind: "conflict" as const,
        reason: `Candidate ${left}:${left + offset + 1}`,
      })),
    );
    const verificationBatchSizes: number[] = [];
    const verificationRequestSizes: number[] = [];
    const store = cache();
    const result = await reviewJointRequirements(
      requirements,
      {
        id: "candidate-verification-batching",
        generate: async (input: any) => {
          if (input.purpose === "joint_requirement_review")
            return { summary: "Reviewed all requirements.", candidates };
          if (input.purpose === "joint_conflict_verification_batch") {
            verificationBatchSizes.push(input.context.tasks.length);
            verificationRequestSizes.push(JSON.stringify(input).length);
            return {
              results: input.context.tasks.map((task: any) => ({
                taskId: task.taskId,
                decision: "unconfirmed",
                reason: `Pending ${task.candidate.left}:${task.candidate.right}`,
                citationIds: [],
              })),
            };
          }
          if (input.purpose === "joint_conflict_verification")
            return {
              decision: "unconfirmed",
              reason: "Pending singleton candidate.",
              citationIds: [],
            };
          throw new Error(`Unexpected verification request: ${input.purpose}`);
        },
      },
      {},
      store,
    );

    expect(result.metrics.candidates).toBe(candidates.length);
    expect(result.metrics.completedVerifications).toBe(candidates.length);
    expect(result.candidateReviews.map(({ left, right }) => [left, right])).toEqual(
      candidates.map(({ left, right }) => [left, right]),
    );
    expect(verificationBatchSizes.every((size) => size <= 4 && size > 1)).toBe(
      true,
    );
    expect(verificationBatchSizes.reduce((sum, size) => sum + size, 0)).toBe(
      candidates.length - 1,
    );
    expect(verificationRequestSizes.every((size) => size <= 48_000)).toBe(true);
    expect(result.metrics.verificationRequests).toBe(verificationBatchSizes.length + 1);
    expect(result.metrics.verificationRequests).toBeLessThan(candidates.length);
  });

  it("reuses individual verification cache hits in mixed batches and on replay", async () => {
    const requirements = Array.from({ length: 4 }, (_, index) =>
      req(`Requirement ${index}`, `doc-${index}`),
    );
    const candidates = [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
    ].map(([left, right]) => ({
      left,
      right,
      kind: "conflict" as const,
      reason: `Candidate ${left}:${right}`,
    }));
    const store = cache();
    let verificationCalls = 0;
    const model = {
      id: "mixed-verification-cache-model",
      generate: async (input: any) => {
        if (input.purpose === "joint_requirement_review")
          return { summary: "Reviewed requirements.", candidates };
        verificationCalls++;
        if (input.purpose === "joint_conflict_verification")
          return {
            decision: "unconfirmed",
            reason: "Pending singleton candidate.",
            citationIds: [],
          };
        return {
          results: input.context.tasks.map((task: any) => ({
            taskId: task.taskId,
            decision: "unconfirmed",
            reason: `Pending ${task.candidate.left}:${task.candidate.right}`,
            citationIds: [],
          })),
        };
      },
    };

    const first = await reviewJointRequirements(requirements, model, {}, store);
    const verificationEntries = [...store.values.entries()].filter(
      ([, value]) =>
        typeof value === "object" &&
        value !== null &&
        "decision" in value &&
        "reason" in value,
    );
    expect(verificationEntries).toHaveLength(candidates.length);
    const preservedKey = verificationEntries[0][0];
    for (const [key] of verificationEntries.slice(1)) store.values.delete(key);
    const callsBeforeMixedRun = verificationCalls;

    const mixed = await reviewJointRequirements(requirements, model, {}, store);

    expect(verificationCalls - callsBeforeMixedRun).toBe(1);
    expect(mixed.metrics.verificationRequests).toBe(1);
    expect(mixed.candidateReviews).toEqual(first.candidateReviews);
    expect(store.values.has(preservedKey)).toBe(true);
    const callsAfterMixedRun = verificationCalls;
    const replay = await reviewJointRequirements(requirements, model, {}, store);
    expect(verificationCalls).toBe(callsAfterMixedRun);
    expect(replay.candidateReviews).toEqual(first.candidateReviews);
  });

  it("uses task-local evidence IDs and validates citations within each candidate", async () => {
    const requirements = [0, 1, 2].map((index) =>
      req(`Requirement ${index}`, `doc-${index}`),
    );
    const candidates = [
      { left: 0, right: 1, kind: "conflict" as const, reason: "A versus B." },
      { left: 1, right: 2, kind: "conflict" as const, reason: "B versus C." },
    ];
    const result = await reviewJointRequirements(
      requirements,
      {
        id: "task-local-evidence-ids",
        generate: async (input: any) => {
          if (input.purpose === "joint_requirement_review")
            return { summary: "Reviewed requirements.", candidates };
          expect(input.purpose).toBe("joint_conflict_verification_batch");
          const evidenceIds = input.context.tasks.map((task: any) =>
            task.evidence.map((evidence: any) => evidence.id),
          );
          expect(new Set(evidenceIds.flat()).size).toBe(4);
          return {
            results: input.context.tasks.map((task: any) => ({
              taskId: task.taskId,
              decision: "conflict",
              reason: "The requirements conflict.",
              citationIds: task.evidence.map((evidence: any) => evidence.id),
            })),
          };
        },
      },
      {},
      cache(),
    );

    expect(result.candidateReviews.map((review) => review.decision)).toEqual([
      "conflict",
      "conflict",
    ]);
    expect(
      result.candidateReviews.map((review) =>
        review.citations.map((citation) => citation.documentVersionId),
      ),
    ).toEqual([
      ["doc-0", "doc-1"],
      ["doc-1", "doc-2"],
    ]);
  });

  it("discards incomplete batches and recursively falls back to singleton cache entries", async () => {
    const requirements = Array.from({ length: 4 }, (_, index) =>
      req(`Requirement ${index}`, `doc-${index}`),
    );
    const candidates = [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
    ].map(([left, right]) => ({
      left,
      right,
      kind: "conflict" as const,
      reason: `Candidate ${left}:${right}`,
    }));
    const store = cache();
    const requestPurposes: string[] = [];
    const model = {
      id: "partial-verification-batch-model",
      generate: async (input: any) => {
        requestPurposes.push(input.purpose);
        if (input.purpose === "joint_requirement_review")
          return { summary: "Reviewed requirements.", candidates };
        if (input.purpose === "joint_conflict_verification_batch")
          return { results: [] };
        const candidate = input.context.candidate;
        return {
          decision: "unconfirmed",
          reason: `Singleton ${candidate.left}:${candidate.right}`,
          citationIds: [],
        };
      },
    };

    const result = await reviewJointRequirements(requirements, model, {}, store);

    expect(result.metrics.candidates).toBe(candidates.length);
    expect(result.metrics.completedVerifications).toBe(candidates.length);
    expect(result.candidateReviews.map(({ left, right }) => [left, right])).toEqual(
      candidates.map(({ left, right }) => [left, right]),
    );
    expect(requestPurposes.filter((purpose) => purpose === "joint_conflict_verification_batch")).toHaveLength(3);
    expect(requestPurposes.filter((purpose) => purpose === "joint_conflict_verification")).toHaveLength(4);
    expect(result.metrics.verificationRequests).toBe(7);
    const callsAfterFirstRun = requestPurposes.length;
    const replay = await reviewJointRequirements(requirements, model, {}, store);
    expect(requestPurposes).toHaveLength(callsAfterFirstRun);
    expect(replay.candidateReviews).toEqual(result.candidateReviews);
  });

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
        const batch = unconfirmedBatch(input);
        if (batch) return batch;
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
    let expectedGroups = 0;
    let releaseGroupBarrier: () => void = () => undefined;
    const allGroupsStarted = new Promise<void>((resolve) => {
      releaseGroupBarrier = resolve;
    });
    const model = {
      id: "pair-coverage-model",
      generate: async (input: any) => {
        active++;
        maximum = Math.max(maximum, active);
        if (active >= expectedGroups) releaseGroupBarrier();
        await Promise.race([
          allGroupsStarted,
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
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
      async (progress) => {
        if (progress.reviewGroupsCompleted === 0)
          expectedGroups = Number(progress.reviewGroupsTotal);
      },
      { concurrency: 32 },
    );
    expect(result.metrics.blocks).toBeGreaterThan(1);
    expect(maximum).toBe(Math.min(32, result.metrics.reviewGroups));
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
    expect(store.values.size).toBe(2); // Group result and merged review aggregate.
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
    const requirements = Array.from({ length: 49 }, (_, i) =>
      req(`Requisito ${i}`, `doc-${i}`),
    );
    const candidates = Array.from({ length: 48 }, (_, i) => ({
      left: i,
      right: i + 1,
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
          const batch = unconfirmedBatch(input);
          if (batch) {
            activeVerifications++;
            maximumVerifications = Math.max(maximumVerifications, activeVerifications);
            if (activeReviews > 0) phaseOverlap = true;
            await new Promise((resolve) => setTimeout(resolve, 4));
            activeVerifications--;
            return batch;
          }
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
      candidates.map((candidate) =>
        `Pendiente ${candidate.left}:${candidate.right}. ${"Further source verification is required. ".repeat(35)}`,
      ),
    );
    expect(progress).toEqual(Array.from({ length: 49 }, (_, index) => index));
  });

  it("runs up to thirty-two verification batches concurrently without losing candidate order", async () => {
    const requirements = Array.from({ length: 18 }, (_, index) =>
      req(`Requirement ${index}`, `doc-${index}`),
    );
    const candidates = requirements.flatMap((_, left) =>
      requirements.slice(left + 1).map((_, offset) => ({
        left,
        right: left + offset + 1,
        kind: "conflict" as const,
        reason: `Candidate ${left}:${left + offset + 1}`,
      })),
    );
    let active = 0;
    let maximumActive = 0;
    const result = await reviewJointRequirements(
      requirements,
      {
        id: "high-throughput-verification",
        generate: async (input: any) => {
          if (input.purpose === "joint_requirement_review")
            return { summary: "Reviewed requirements.", candidates };
          const batch = unconfirmedBatch(input);
          active++;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return (
            batch ?? {
              decision: "unconfirmed",
              reason: "Pending singleton.",
              citationIds: [],
            }
          );
        },
      },
      {},
      cache(),
      undefined,
      { verificationConcurrency: 32 },
    );

    expect(maximumActive).toBeGreaterThanOrEqual(31);
    expect(maximumActive).toBeLessThanOrEqual(32);
    expect(result.metrics.candidates).toBe(candidates.length);
    expect(result.metrics.completedVerifications).toBe(candidates.length);
    expect(result.candidateReviews.map(({ left, right }) => [left, right])).toEqual(
      candidates.map(({ left, right }) => [left, right]),
    );
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
        const batch = unconfirmedBatch(input);
        if (batch) {
          verificationCalls++;
          const batchTasks = input.context.tasks;
          if (
            failFirstPair &&
            batchTasks.some((task: any) => task.candidate.left === 0)
          )
            return { results: [] };
          for (const task of batchTasks) successfulPairs.add(task.candidate.left);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return batch;
        }
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
    expect(verificationCalls).toBe(5);
    expect(successfulPairs.size).toBeGreaterThan(0);
    expect(successfulPairs.size).toBeLessThan(candidates.length);
    expect(store.values.size).toBeGreaterThan(successfulPairs.size);

    failFirstPair = false;
    const callsBeforeResume = verificationCalls;
    const resumed = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
    );
    expect(verificationCalls - callsBeforeResume).toBe(1);
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

  it("resumes after the contiguous cached group prefix and preserves the complete review", async () => {
    const requirements = Array.from({ length: 6 }, (_, i) =>
      req(`Requirement ${i}: ${"x".repeat(12_000)}`, `doc-${i}`),
    );
    const backing = cache();
    const completedKeys = new Set<string>();
    const events: string[] = [];
    const store = {
      get: async (key: string) => {
        if (completedKeys.has(key)) events.push(`cached:${key}`);
        return backing.get(key);
      },
      put: async (key: string, value: unknown) => {
        await backing.put(key, value);
        completedKeys.add(key);
      },
    };
    let failFinalGroup = true;
    let reviewCallIndex = 0;
    const model = {
      id: "contiguous-review-resume",
      generate: async (input: any) => {
        if (input.purpose === "joint_conflict_verification") {
          return {
            decision: "unconfirmed",
            reason: `Pending ${input.context.candidate.left}:${input.context.candidate.right}`,
            citationIds: [],
          };
        }
        const callIndex = reviewCallIndex++;
        const { left, right } =
          input.outputSchema.properties.candidates.items.properties;
        events.push(`review:${callIndex}`);
        if (callIndex === 0)
          await new Promise((resolve) => setTimeout(resolve, 25));
        if (callIndex === 1)
          await new Promise((resolve) => setTimeout(resolve, 1));
        if (callIndex === 2 && failFinalGroup) {
          failFinalGroup = false;
          throw new DossierError("MODEL_BUDGET_EXCEEDED", 429, true);
        }
        const indices = input.context.requirements.map((row: any[]) => row[0]);
        const canUse = (index: number, bounds: any) =>
          index >= bounds.minimum && index <= bounds.maximum;
        const candidates = [];
        for (const [offset, first] of indices.entries()) {
          for (const second of indices.slice(offset + 1)) {
            if (canUse(first, left) && canUse(second, right))
              candidates.push({
                left: first,
                right: second,
                kind: "conflict",
                reason: `Pair ${first}:${second}`,
              });
            else if (canUse(second, left) && canUse(first, right))
              candidates.push({
                left: second,
                right: first,
                kind: "conflict",
                reason: `Pair ${first}:${second}`,
              });
          }
        }
        return {
          summary: `Group summary ${Math.min(...indices)}-${Math.max(...indices)}`,
          candidates,
        };
      },
    };
    let savedProgress: Record<string, unknown> = {};
    const checkpoint = async (progress: Record<string, unknown>) => {
      savedProgress = { ...savedProgress, ...progress };
    };
    const reviewOptions: any = { concurrency: 2, revision: 4 };

    await expect(
      reviewJointRequirements(
        requirements,
        model,
        {},
        store,
        checkpoint,
        reviewOptions,
      ),
    ).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
    expect(savedProgress.reviewGroupsCursor).toBe(2);
    expect(typeof savedProgress.reviewGroupsFingerprint).toBe("string");
    expect(savedProgress.reviewGroupsCompleted).toBe(2);
    const cachedPrefixKeys = new Set(completedKeys);
    expect(cachedPrefixKeys.size).toBe(2);
    events.length = 0;

    const resumed = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
      checkpoint,
      {
        ...reviewOptions,
        resume: {
          cursor: savedProgress.reviewGroupsCursor,
          fingerprint: savedProgress.reviewGroupsFingerprint,
        },
      },
    );

    const firstNewGroupCall = events.findIndex((event) => event.startsWith("review:"));
    expect(firstNewGroupCall).toBeGreaterThanOrEqual(0);
    expect(
      events.slice(0, firstNewGroupCall).some((event) =>
        event.startsWith("cached:"),
      ),
    ).toBe(false);
    const baseline = await reviewJointRequirements(
      requirements,
      model,
      {},
      cache(),
      undefined,
      reviewOptions,
    );
    expect(resumed.summaries).toEqual(baseline.summaries);
    expect(resumed.conflicts).toEqual(baseline.conflicts);
    expect(resumed.amendments).toEqual(baseline.amendments);
    expect(resumed.metrics.comparedPairs).toBe(15);
    expect(resumed.metrics.reviewGroups).toBe(baseline.metrics.reviewGroups);
    expect(
      resumed.candidateReviews
        .map(({ left, right }) => `${left}:${right}`)
        .sort(),
    ).toEqual(
      Array.from({ length: 6 }, (_, left) =>
        Array.from(
          { length: 6 - left - 1 },
          (_, offset) => `${left}:${left + offset + 1}`,
        ),
      )
        .flat()
        .sort(),
    );
    expect(resumed.candidateReviews).toEqual(baseline.candidateReviews);
    expect([...cachedPrefixKeys].every((key) => backing.values.has(key))).toBe(
      true,
    );
    events.length = 0;
    const verificationReplay = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
      checkpoint,
      {
        ...reviewOptions,
        resume: {
          cursor: savedProgress.reviewGroupsCursor,
          fingerprint: savedProgress.reviewGroupsFingerprint,
        },
      },
    );
    expect(verificationReplay.candidateReviews).toEqual(
      resumed.candidateReviews,
    );
    expect(
      events.some(
        (event) =>
          event.startsWith("cached:") &&
          cachedPrefixKeys.has(event.slice("cached:".length)),
      ),
    ).toBe(false);
    expect(events.some((event) => event.startsWith("review:"))).toBe(false);
  });

  it("reloads a large cached prefix with bounded parallel cache reads", async () => {
    const requirements = Array.from({ length: 16 }, (_, i) =>
      req(`Requirement ${i}: ${"x".repeat(5_000)}`, `doc-${i}`),
    );
    const rows = new Map<string, unknown>();
    let activeReads = 0;
    let maxActiveReads = 0;
    const store = {
      get: async (key: string) => {
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeReads--;
        return rows.get(key) ?? null;
      },
      put: async (key: string, value: unknown) => void rows.set(key, value),
    };
    const model = {
      id: "bounded-prefix-cache-reload",
      generate: async () => ({ summary: "Complete group", candidates: [] }),
    };
    let savedProgress: Record<string, unknown> = {};
    const checkpoint = async (progress: Record<string, unknown>) => {
      savedProgress = { ...savedProgress, ...progress };
    };

    const result = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
      checkpoint,
      { revision: 1, concurrency: 64 },
    );
    const groupCount = result.metrics.reviewGroups;
    expect(groupCount).toBeGreaterThanOrEqual(10);

    const fingerprint = String(savedProgress.reviewGroupsFingerprint);
    rows.delete(`joint.aggregate.v1.${fingerprint}`);
    maxActiveReads = 0;
    const replay = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
      checkpoint,
      {
        revision: 1,
        concurrency: 64,
        resume: {
          cursor: groupCount,
          fingerprint,
        },
      },
    );

    expect(replay.summaries).toEqual(result.summaries);
    expect(replay.candidateReviews).toEqual(result.candidateReviews);
    expect(maxActiveReads).toBeGreaterThan(1);
    expect(maxActiveReads).toBeLessThanOrEqual(64);
  });

  it.each([
    {
      change: "model",
      modelId: "different-model",
      revision: 4,
      firstWording: "Requirement A",
    },
    {
      change: "corpus revision",
      modelId: "resume-fingerprint-model",
      revision: 5,
      firstWording: "Requirement A",
    },
    {
      change: "plan",
      modelId: "resume-fingerprint-model",
      revision: 4,
      firstWording: "Updated requirement A",
    },
  ])("resets a saved cursor when the $change fingerprint changes", async ({ modelId, revision, firstWording }) => {
    const requirements = [
      req("Requirement A", "doc-a"),
      req("Requirement B", "doc-b"),
    ];
    const store = cache();
    const firstModel = {
      id: "resume-fingerprint-model",
      generate: async () => ({ summary: "Original summary", candidates: [] }),
    };
    let savedProgress: Record<string, unknown> = {};
    const checkpoint = async (progress: Record<string, unknown>) => {
      savedProgress = { ...savedProgress, ...progress };
    };
    await reviewJointRequirements(
      requirements,
      firstModel,
      {},
      store,
      checkpoint,
      { revision: 4 },
    );
    const mismatchedModel = {
      id: modelId,
      generate: async () => ({ summary: "Updated summary", candidates: [] }),
    };
    const initialProgress: Record<string, unknown>[] = [];
    await reviewJointRequirements(
      [req(firstWording, "doc-a"), requirements[1]],
      mismatchedModel,
      {},
      store,
      async (progress) => {
        initialProgress.push(progress);
      },
      {
        revision,
        resume: {
          cursor: savedProgress.reviewGroupsCursor as number,
          fingerprint: savedProgress.reviewGroupsFingerprint as string,
        },
      },
    );
    expect(initialProgress[0].reviewGroupsCursor).toBe(0);
  });

  it("resets an out-of-range saved cursor before processing any group", async () => {
    const requirements = [
      req("Requirement A", "doc-a"),
      req("Requirement B", "doc-b"),
    ];
    const store = cache();
    const failingModel = {
      id: "invalid-review-cursor",
      generate: async () => {
        throw new DossierError("MODEL_BUDGET_EXCEEDED", 429, true);
      },
    };
    let fingerprint = "";
    await expect(
      reviewJointRequirements(
        requirements,
        failingModel,
        {},
        store,
        async (progress) => {
          fingerprint = String(progress.reviewGroupsFingerprint ?? fingerprint);
        },
        { revision: 4 },
      ),
    ).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });

    const progress: Record<string, unknown>[] = [];
    await reviewJointRequirements(
      requirements,
      {
        id: "invalid-review-cursor",
        generate: async () => ({ summary: "Complete", candidates: [] }),
      },
      {},
      store,
      async (value) => {
        progress.push(value);
      },
      {
        revision: 4,
        resume: { cursor: 99, fingerprint },
      },
    );
    expect(progress[0].reviewGroupsCursor).toBe(0);
  });

  it("settles in-flight review caches on failure and reuses them on the next attempt", async () => {
    const requirements = Array.from({ length: 48 }, (_, i) =>
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
      reviewJointRequirements(
        requirements,
        model,
        {},
        store,
        undefined,
        { concurrency: 32 },
      ),
    ).rejects.toThrow("temporary inference failure");
    expect(calls).toBe(32);
    expect(store.values.size).toBe(31);
    failing = false;
    const resumed = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
      undefined,
      { concurrency: 32 },
    );
    expect(repeatedGroups).toEqual([]);
    expect(resumed.metrics.comparedPairs).toBe((48 * 47) / 2);
    expect(successfulGroups.size).toBe(resumed.metrics.reviewGroups);
  });

  it("splits a truncated joint group and merges both halves", async () => {
    const requirements = Array.from({ length: 20 }, (_, i) =>
      req(`Requirement ${i}`, `doc-${i}`),
    );
    const store = cache();
    let truncations = 0;
    let reviewCalls = 0;
    const model = {
      id: "splitting-review-model",
      generate: async (input: any) => {
        const batch = unconfirmedBatch(input);
        if (batch) return batch;
        if (input.purpose === "joint_conflict_verification") {
          return {
            decision: "unconfirmed",
            reason: "Further source verification is required.",
            citationIds:
              input.outputSchema.properties.citationIds.items.enum.slice(0, 1),
          };
        }
        reviewCalls++;
        const indices = input.context.requirements.map((r: any[]) => r[0]);
        if (indices.length > 6) {
          truncations++;
          throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
        }
        const schema = input.outputSchema.properties.candidates.items.properties;
        const leftIndices = indices.filter(
          (i: number) => i >= schema.left.minimum && i <= schema.left.maximum,
        );
        const rightIndices = indices.filter(
          (i: number) => i >= schema.right.minimum && i <= schema.right.maximum,
        );
        const pairs = [];
        for (const left of leftIndices)
          for (const right of rightIndices)
            if (left < right && right - left === 1)
              pairs.push({
                left,
                right,
                kind: "conflict",
                reason: "Neighbor obligations overlap.",
              });
        return {
          summary: `Compared ${indices.length} requirements.`,
          candidates: pairs,
        };
      },
    };
    const result = await reviewJointRequirements(
      requirements,
      model,
      { total: 20, pending: [], reviewRequired: [] },
      store,
    );
    expect(truncations).toBeGreaterThan(0);
    const pairs = result.candidateReviews.map(({ left, right }) => [left, right]);
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).toContainEqual([18, 19]);
    expect(result.summaries.length).toBeGreaterThan(0);
    const reviewCallsAfterFirstRun = reviewCalls;
    await reviewJointRequirements(
      requirements,
      model,
      { total: 20, pending: [], reviewRequired: [] },
      store,
    );
    expect(reviewCalls).toBe(reviewCallsAfterFirstRun);
  });

  it("compares pairs spanning both sides of a truncated group split", async () => {
    const requirements = Array.from({ length: 20 }, (_, i) =>
      req(`Requirement ${i}`, `doc-${i}`),
    );
    const model = {
      id: "far-pair-review-model",
      generate: async (input: any) => {
        if (input.purpose === "joint_conflict_verification")
          return {
            decision: "unconfirmed",
            reason: "Further source verification is required.",
            citationIds:
              input.outputSchema.properties.citationIds.items.enum.slice(0, 2),
          };
        const indices = input.context.requirements.map((r: any[]) => r[0]);
        if (indices.length > 6)
          throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
        return {
          summary: "Compared requirements.",
          candidates:
            indices.includes(0) &&
            indices.includes(19) &&
            indices[0] === 0 &&
            input.outputSchema.properties.candidates.items.properties.left
              .minimum === 0 &&
            input.outputSchema.properties.candidates.items.properties.right
              .maximum === 19
              ? [
                  {
                    left: 0,
                    right: 19,
                    kind: "conflict",
                    reason: "Far pair.",
                  },
                ]
              : [],
        };
      },
    };
    const result = await reviewJointRequirements(requirements, model, {}, cache());
    expect(result.candidateReviews.map(({ left, right }) => [left, right])).toContainEqual([0, 19]);
  });

  it("retains summary content from the right half of a truncated group", async () => {
    const requirements = Array.from({ length: 20 }, (_, i) =>
      req(`Requirement ${i}`, `doc-${i}`),
    );
    const model = {
      id: "right-half-summary-model",
      generate: async (input: any) => {
        if (input.purpose === "joint_conflict_verification")
          return {
            decision: "unconfirmed",
            reason: "Further source verification is required.",
            citationIds:
              input.outputSchema.properties.citationIds.items.enum.slice(0, 2),
          };
        const indices = input.context.requirements.map((r: any[]) => r[0]);
        if (indices.length > 6)
          throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
        return {
          summary: indices.includes(19)
            ? "RIGHTMOST-REQUIREMENT-SUMMARY"
            : "Other requirements.",
          candidates: [],
        };
      },
    };
    const result = await reviewJointRequirements(requirements, model, {}, cache());
    expect(result.summaries.join(" ")).toContain("RIGHTMOST-REQUIREMENT-SUMMARY");
  });

  it("retains original cross-block scopes while recursively splitting", async () => {
    const requirements = Array.from({ length: 10 }, (_, i) =>
      req(`Requirement ${i} ${"detail ".repeat(1_100)}`, `doc-${i}`),
    );
    let truncatedCrossBlocks = 0;
    let foundFarPair = false;
    const model = {
      id: "cross-block-split-model",
      generate: async (input: any) => {
        if (input.purpose === "joint_conflict_verification")
          return {
            decision: "unconfirmed",
            reason: "Further source verification is required.",
            citationIds:
              input.outputSchema.properties.citationIds.items.enum.slice(0, 2),
          };
        const indices = input.context.requirements.map((r: any[]) => r[0]);
        const schema = input.outputSchema.properties.candidates.items.properties;
        const left = indices.filter(
          (i: number) => i >= schema.left.minimum && i <= schema.left.maximum,
        );
        const right = indices.filter(
          (i: number) => i >= schema.right.minimum && i <= schema.right.maximum,
        );
        if (indices.length > 2) {
          truncatedCrossBlocks++;
          throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
        }
        if (left.includes(0) && right.includes(9)) foundFarPair = true;
        return {
          summary: "Compared scoped requirements.",
          candidates: left.flatMap((a: number) =>
            right
              .filter((b: number) => a < b && a === 0 && b === 9)
              .map((b: number) => ({
                left: a,
                right: b,
                kind: "conflict",
                reason: "Cross-block pair.",
              })),
          ),
        };
      },
    };
    const result = await reviewJointRequirements(requirements, model, {}, cache());
    expect(truncatedCrossBlocks).toBeGreaterThan(0);
    expect(foundFarPair).toBe(true);
    expect(
      result.candidateReviews.map(({ left, right }) => [left, right]),
    ).toContainEqual([0, 9]);
  });

  it("replays aggregates larger than one response without parsing them as a leaf", async () => {
    const requirements = Array.from({ length: 26 }, (_, i) =>
      req(`Requirement ${i}`, `doc-${i}`),
    );
    const store = cache();
    let reviewCalls = 0;
    const model = {
      id: "large-split-review-model",
      generate: async (input: any) => {
        const batch = unconfirmedBatch(input);
        if (batch) return batch;
        if (input.purpose === "joint_conflict_verification")
          return {
            decision: "unconfirmed",
            reason: "Further source verification is required.",
            citationIds:
              input.outputSchema.properties.citationIds.items.enum.slice(0, 2),
          };
        reviewCalls++;
        const indices = input.context.requirements.map((r: any[]) => r[0]);
        const leftRange =
          input.outputSchema.properties.candidates.items.properties.left;
        const rightRange =
          input.outputSchema.properties.candidates.items.properties.right;
        const left = indices.filter(
          (i: number) => i >= leftRange.minimum && i <= leftRange.maximum,
        );
        const right = indices.filter(
          (i: number) => i >= rightRange.minimum && i <= rightRange.maximum,
        );
        const cross = leftRange.maximum < rightRange.minimum;
        const candidates = cross
          ? left.flatMap((a: number) =>
              right.map((b: number) => ({
                left: a,
                right: b,
                kind: "conflict",
                reason: "Compare.",
              })),
            )
          : indices.flatMap((a: number, i: number) =>
              indices.slice(i + 1).map((b: number) => ({
                left: a,
                right: b,
                kind: "conflict",
                reason: "Compare.",
              })),
            );
        if (candidates.length > 200)
          throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
        return { summary: "Compared group.", candidates };
      },
    };
    const first = await reviewJointRequirements(requirements, model, {}, store);
    expect(first.candidateReviews.length).toBeGreaterThan(200);
    const callsAfterFirstRun = reviewCalls;
    const replay = await reviewJointRequirements(requirements, model, {}, store);
    expect(reviewCalls).toBe(callsAfterFirstRun);
    expect(replay.candidateReviews).toHaveLength((26 * 25) / 2);
    expect(replay.candidateReviews).toEqual(first.candidateReviews);
  });

  it("terminates when a minimal cross-scope pair truncates", async () => {
    let reviewCalls = 0;
    await expect(
      reviewJointRequirements(
        [req("First", "doc-a"), req("Second", "doc-b")],
        {
          id: "minimal-pair-review-model",
          generate: async (input: any) => {
            reviewCalls++;
            if (input.context.requirements.length === 1)
              return { summary: "Single requirement.", candidates: [] };
            throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
          },
        },
        {},
        cache(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_TRUNCATED" });
    expect(reviewCalls).toBe(3);
  });

  it.each([200, 210])(
    "subdivides a saturated joint response with %i candidates and replays its split marker",
    async (parentCandidateCount) => {
      const requirements = Array.from({ length: 21 }, (_, index) =>
        req(`Requirement ${index}`, `doc-${index}`),
      );
      const store = cache();
      let reviewCalls = 0;
      let verificationCalls = 0;
      const model = {
        id: `candidate-cap-${parentCandidateCount}-model`,
        generate: async (input: any) => {
          const batch = unconfirmedBatch(input);
          if (batch) return batch;
          if (input.purpose === "joint_conflict_verification") {
            verificationCalls++;
            return {
              decision: "unconfirmed",
              reason: "The evidence does not establish a conflict.",
              citationIds: [],
            };
          }
          reviewCalls++;
          const rows = input.context.requirements;
          const { left, right } =
            input.outputSchema.properties.candidates.items.properties;
          const leftIndices = rows
            .map((row: any[]) => row[0])
            .filter(
              (index: number) => index >= left.minimum && index <= left.maximum,
            );
          const rightIndices = rows
            .map((row: any[]) => row[0])
            .filter(
              (index: number) =>
                index >= right.minimum && index <= right.maximum,
            );
          const pairs =
            left.minimum === right.minimum && left.maximum === right.maximum
              ? leftIndices.flatMap((a: number, i: number) =>
                  leftIndices.slice(i + 1).map((b: number) => [a, b]),
                )
              : leftIndices.flatMap((a: number) =>
                  rightIndices.map((b: number) => [a, b]),
                );
          const candidates = pairs.map(([a, b]: number[]) => ({
            left: a,
            right: b,
            kind: "conflict",
            reason: "Compare the stated requirements.",
          }));
          return {
            summary: "Compare the grouped requirements.",
            candidates:
              rows.length === 21
                ? candidates.slice(0, parentCandidateCount)
                : candidates,
          };
        },
      };

      const first = await reviewJointRequirements(
        requirements,
        model,
        {},
        store,
      );
      expect(first.metrics.candidates).toBe((21 * 20) / 2);
      expect(first.metrics.completedVerifications).toBe((21 * 20) / 2);
      expect(first.metrics.verificationRequests).toBeLessThan((21 * 20) / 2);
      expect(reviewCalls).toBeGreaterThan(1);
      expect(
        [...store.values.values()].some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "split" in value &&
            value.split === true,
        ),
      ).toBe(true);
      const callsAfterFirstRun = reviewCalls + verificationCalls;

      const replay = await reviewJointRequirements(
        requirements,
        model,
        {},
        store,
      );
      expect(reviewCalls + verificationCalls).toBe(callsAfterFirstRun);
      expect(replay.candidateReviews).toEqual(first.candidateReviews);
    },
  );

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

  it("keeps oversized candidate verification unconfirmed and replays its checkpoint", async () => {
    const requirements = [
      req("Requirement A", "doc-a"),
      req("Requirement B", "doc-b"),
    ];
    requirements[0].citations[0].excerpt = "A".repeat(25_000);
    requirements[1].citations[0].excerpt = "B".repeat(25_000);
    const store = cache();
    const checkpoints: unknown[] = [];
    let reviewCalls = 0;
    let verificationCalls = 0;
    const model = {
      id: "oversized-verification-model",
      generate: async (input: any) => {
        if (input.purpose === "joint_requirement_review") {
          reviewCalls++;
          return {
            summary: "Se detectó una relación que requiere verificación.",
            candidates: [
              {
                left: 0,
                right: 1,
                kind: "conflict",
                reason: "Las obligaciones parecen incompatibles.",
              },
            ],
          };
        }
        verificationCalls++;
        return {
          decision: "conflict",
          reason: "This must not be returned.",
          citationIds: input.outputSchema.properties.citationIds.items.enum,
        };
      },
    };
    const checkpoint = async (value: unknown) => {
      checkpoints.push(value);
    };

    const first = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
      checkpoint,
    );

    expect(first.candidateReviews).toEqual([
      {
        left: 0,
        right: 1,
        decision: "unconfirmed",
        reason:
          "La evidencia citada excede el límite de contexto para verificación; se conserva como no confirmada.",
        citations: [],
      },
    ]);
    expect(first.metrics.verifiedCandidates).toBe(0);
    expect(first.metrics.completedVerifications).toBe(1);
    expect(first.metrics.verificationRequests).toBe(0);
    expect(verificationCalls).toBe(0);
    expect(checkpoints).toContainEqual({
      phase: "joint_verification",
      candidatesCompleted: 1,
      candidatesTotal: 1,
    });

    const replay = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
      checkpoint,
    );
    expect(replay.candidateReviews).toEqual(first.candidateReviews);
    expect(reviewCalls).toBe(1);
    expect(verificationCalls).toBe(0);
  });

  it("bounds source tables per group and replays every pair from cache", async () => {
    const requirements = Array.from({ length: 32 }, (_, requirementIndex) => ({
      ...req(`Requirement ${requirementIndex}`, `unused-${requirementIndex}`),
      citations: Array.from({ length: 20 }, (_, citationIndex) => ({
        documentVersionId: `doc-${requirementIndex}-${citationIndex}-${"x".repeat(180)}`,
        page: citationIndex + 1,
        excerpt: `Evidence ${requirementIndex}-${citationIndex}`,
      })),
    }));
    const store = cache();
    let reviewCalls = 0;
    let maxInputChars = 0;
    const offeredPairs = new Set<string>();
    const model = {
      id: "group-local-source-model",
      generate: async (input: any) => {
        reviewCalls++;
        const inputChars = JSON.stringify(input).length;
        maxInputChars = Math.max(maxInputChars, inputChars);
        expect(inputChars).toBeLessThanOrEqual(48_000);
        const { documents, sources, requirements: rows } = input.context;
        expect(documents.length).toBeLessThan(32 * 20);
        expect(sources.length).toBeLessThan(32 * 20);
        for (const row of rows) {
          for (const sourceIndex of row[7]) {
            expect(sourceIndex).toBeGreaterThanOrEqual(0);
            expect(sourceIndex).toBeLessThan(sources.length);
            const source = sources[sourceIndex];
            expect(documents[source[0]]).toContain(`doc-${row[0]}-`);
          }
        }
        for (const source of sources) {
          expect(source[0]).toBeGreaterThanOrEqual(0);
          expect(source[0]).toBeLessThan(documents.length);
        }
        for (const [offset, left] of rows.entries())
          for (const right of rows.slice(offset + 1))
            offeredPairs.add(`${left[0]}:${right[0]}`);
        return { summary: "Compared group.", candidates: [] };
      },
    };
    const first = await reviewJointRequirements(requirements, model, {}, store);
    expect(first.metrics.comparedPairs).toBe((32 * 31) / 2);
    expect(first.metrics.reviewRequests).toBeGreaterThan(1);
    expect(maxInputChars).toBeLessThanOrEqual(48_000);
    expect(offeredPairs.size).toBe((32 * 31) / 2);
    const callsAfterFirstRun = reviewCalls;
    const replay = await reviewJointRequirements(
      requirements,
      model,
      {},
      store,
    );
    expect(reviewCalls).toBe(callsAfterFirstRun);
    expect(replay.metrics.comparedPairs).toBe((32 * 31) / 2);
  });

  it("packs larger safe blocks under the unchanged request limit without losing pairs", async () => {
    const requirements = Array.from({ length: 20 }, (_, index) =>
      req(`Requirement ${index}: ${"x".repeat(4_300)}`, `doc-${index}`),
    );
    const offeredPairs = new Set<string>();
    let maxRequestChars = 0;
    const model = {
      id: "larger-joint-blocks",
      generate: async (input: any) => {
        maxRequestChars = Math.max(maxRequestChars, JSON.stringify(input).length);
        const indices = input.context.requirements.map((row: any[]) => row[0]);
        const { left, right } =
          input.outputSchema.properties.candidates.items.properties;
        const canUse = (index: number, bounds: any) =>
          index >= bounds.minimum && index <= bounds.maximum;
        for (const [offset, leftIndex] of indices.entries())
          for (const rightIndex of indices.slice(offset + 1))
            if (
              (canUse(leftIndex, left) && canUse(rightIndex, right)) ||
              (canUse(rightIndex, left) && canUse(leftIndex, right))
            )
              offeredPairs.add(`${leftIndex}:${rightIndex}`);
        return { summary: "Compared group.", candidates: [] };
      },
    };

    const result = await reviewJointRequirements(
      requirements,
      model,
      {},
      cache(),
    );
    expect(result.metrics.reviewGroups).toBeLessThan(15);
    expect(result.metrics.comparedPairs).toBe((20 * 19) / 2);
    expect(offeredPairs.size).toBe((20 * 19) / 2);
    expect(maxRequestChars).toBeLessThanOrEqual(48_000);
  });
});
