import { describe, expect, it, vi } from "vitest";
import { assessCompany } from "../src/dossier/assessment";
import { buildExhaustiveChecklist } from "../src/dossier/checklist";
import type { DossierRepository } from "../src/dossier/repository";

const requirementIds = Array.from(
  { length: 5_001 },
  (_, index) => `requirement-${index}`,
);
const dossierId = "CO1.REQ.445566";
const corpusRevision = 7;
const reportId = `${dossierId}:${corpusRevision}`;
const sourceText = "The bidder must provide the requested evidence.";
const evidenceChunk = {
  documentVersionId: "document-1",
  page: 1,
  index: 0,
  text: sourceText,
};

function requirements() {
  return new Map(
    requirementIds.map((id, index) => [
      id,
      {
        dossierId,
        corpusRevision,
        wording: `Condition ${index}`,
        category: "experience",
        mandatory: true,
        lot: null,
        deadline: null,
        rule: null,
        citations: [
          {
            documentVersionId: "document-1",
            page: 1,
            excerpt: sourceText,
          },
        ],
      },
    ]),
  );
}

describe("large saved requirement lists", () => {
  it("loads every checklist requirement in bounded batches and report order", async () => {
    const savedRequirements = requirements();
    const requirementBatchSizes: number[] = [];
    const repo = {
      readDossier: async () => ({
        id: dossierId,
        revision: 1,
        value: {
          corpusRevision,
          documentIds: ["document-1"],
          coverage: { inventoryComplete: true },
        },
      }),
      readMany: async (kind: string, ids: string[]) => {
        if (kind === "requirement") {
          requirementBatchSizes.push(ids.length);
          if (ids.length > 100) throw new Error("unbounded requirement read");
          return ids.map((id) => ({
            id,
            revision: 1,
            value: savedRequirements.get(id),
          }));
        }
        return ids.map((id) => ({
          id,
          revision: 1,
          value: { name: "Pliego.pdf", state: "ready" },
        }));
      },
      now: () => Date.parse("2026-10-22T12:00:00.000Z"),
    } as unknown as DossierRepository;

    const checklist = await buildExhaustiveChecklist(
      repo,
      dossierId,
      corpusRevision,
      reportId,
      { dossierId, corpusRevision, requirementIds },
      [evidenceChunk],
      null,
    );

    expect(requirementBatchSizes).toHaveLength(51);
    expect(Math.max(...requirementBatchSizes)).toBe(100);
    expect(requirementBatchSizes.at(-1)).toBe(1);
    expect(checklist.items).toHaveLength(5_001);
    expect(checklist.items[0].requirementId).toBe("requirement-0");
    expect(checklist.items.at(-1)?.requirementId).toBe("requirement-5000");
  });

  it("assesses every requirement in bounded batches and preserves finding order", async () => {
    const savedRequirements = requirements();
    const requirementBatchSizes: number[] = [];
    const noModelCalls = vi.fn(async () => {
      throw new Error("model should not be called without company evidence");
    });
    const company = {
      name: "Example company",
      legalId: "",
      activities: "",
      facts: [],
    };
    const report = {
      corpusRevision,
      requirementIds,
      coverage: { total: 1, pending: [], reviewRequired: [] },
      conflicts: [],
    };
    const dossier = {
      corpusRevision,
      reportId,
      needsSynthesis: false,
      documentIds: [],
    };
    const repo = {
      readDossier: async () => ({ id: dossierId, revision: 1, value: dossier }),
      read: async (kind: string) =>
        kind === "report"
          ? { id: reportId, revision: 1, value: report }
          : { id: "company-1", revision: 1, value: company },
      allMatching: async () => [],
      readMany: async (_kind: string, ids: string[]) => {
        requirementBatchSizes.push(ids.length);
        if (ids.length > 100) throw new Error("unbounded requirement read");
        return ids.map((id) => ({
          id,
          revision: 1,
          value: savedRequirements.get(id),
        }));
      },
      upsert: async () => undefined,
      now: () => Date.parse("2026-10-22T12:00:00.000Z"),
    } as unknown as DossierRepository;

    const assessment = await assessCompany(
      repo,
      dossierId,
      "company-1",
      [],
      { id: "test-model", generate: noModelCalls },
      { createTasks: false },
    );

    expect(requirementBatchSizes).toHaveLength(51);
    expect(Math.max(...requirementBatchSizes)).toBe(100);
    expect(requirementBatchSizes.at(-1)).toBe(1);
    expect(assessment.findings).toHaveLength(5_001);
    expect(assessment.findings[0].requirementId).toBe("requirement-0");
    expect(assessment.findings.at(-1)?.requirementId).toBe(
      "requirement-5000",
    );
    expect(noModelCalls).not.toHaveBeenCalled();
  });
});
