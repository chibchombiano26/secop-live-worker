import { describe, expect, it } from "vitest";
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
    const model = {
      id: "pair-coverage-model",
      generate: async (input: any) => {
        if (input.purpose === "joint_requirement_review") {
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
    expect(result.metrics.requirements).toBe(14);
    expect(observed.size).toBe((14 * 13) / 2);
    expect(observed.has("0:13")).toBe(true);
    expect(observed.has("12:13")).toBe(true);
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
