import { describe, it, expect } from "vitest";
import {
  validateCitations,
  extractRequirements,
} from "../src/dossier/synthesis";
import {
  modelExtractionConcurrency,
  modelJointReviewConcurrency,
} from "../src/dossier/model-concurrency";
import type { EvidenceChunk } from "../src/dossier/extraction";
const chunks: EvidenceChunk[] = [
  {
    documentVersionId: "pliego",
    page: 2,
    text: "Minimum experience: three contracts.",
    index: 0,
  },
  {
    documentVersionId: "adenda",
    page: 1,
    text: "Amendment: minimum experience is now two contracts.",
    index: 1,
  },
];
describe("grounded cross-document synthesis", () => {
  it("constrains generated citations to the actual source identity, page and exact excerpt choices", async () => {
    let schema: any;
    await extractRequirements([chunks[0]], {
      id: "test",
      generate: async (input) => {
        schema = input.outputSchema;
        return { summary: "source", requirements: [], conflicts: [] };
      },
    });
    const citation =
      schema.properties.requirements.items.properties.citations.items;
    expect(citation.properties.documentVersionId.const).toBe("pliego");
    expect(citation.properties.page.const).toBe(2);
    expect(citation.required).toContain("page");
    expect(citation.properties.section).toBeUndefined();
    const options = citation.properties.excerpt.enum;
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((text: string) => chunks[0].text.includes(text))).toBe(
      true,
    );
  });

  it("bounds dense extraction fragments while visiting the final source text", async () => {
    const visited: string[] = [];
    await extractRequirements(
      [
        {
          documentVersionId: "long",
          page: 1,
          index: 0,
          text: "Background ".repeat(450) + "FINAL REQUIREMENT",
        },
      ],
      {
        id: "test",
        generate: async (input) => {
          visited.push(input.evidence[0].text);
          return { summary: "source", requirements: [], conflicts: [] };
        },
      },
    );
    expect(visited.every((t) => t.length <= 2000)).toBe(true);
    expect(visited.some((t) => t.includes("FINAL REQUIREMENT"))).toBe(true);
  });
  it("restores exact source whitespace without accepting changed wording", () => {
    const source = [
      {
        documentVersionId: "scan",
        page: 1,
        text: "Required experience:\n  three contracts.",
        index: 0,
      },
    ];
    expect(
      validateCitations(
        [
          {
            documentVersionId: "scan",
            page: 1,
            excerpt: "experience: three contracts",
          },
        ],
        source,
      )[0].excerpt,
    ).toBe("experience:\n  three contracts");
    expect(() =>
      validateCitations(
        [
          {
            documentVersionId: "scan",
            page: 1,
            excerpt: "experience: four contracts",
          },
        ],
        source,
      ),
    ).toThrow("INVALID_CITATION");
  });
  it("checks excerpts, versions and actual parser pages", () => {
    expect(
      validateCitations(
        [{ documentVersionId: "pliego", page: 2, excerpt: "three contracts" }],
        chunks,
      ),
    ).toHaveLength(1);
    expect(() =>
      validateCitations(
        [{ documentVersionId: "pliego", page: 99, excerpt: "three contracts" }],
        chunks,
      ),
    ).toThrow("INVALID_CITATION");
    expect(() =>
      validateCitations(
        [{ documentVersionId: "other", excerpt: "three contracts" }],
        chunks,
      ),
    ).toThrow("INVALID_CITATION");
    expect(() =>
      validateCitations(
        [{ documentVersionId: "pliego", page: 2, excerpt: "one contract" }],
        chunks,
      ),
    ).toThrow("INVALID_CITATION");
  });
  it("visits all chunks and preserves cited requirements and conflicts", async () => {
    const visited: string[] = [];
    const model = {
      id: "test",
      generate: async (input: any) => {
        visited.push(input.evidence[0].documentVersionId);
        const chunk = input.evidence[0];
        return {
          requirements: [
            {
              wording: chunk.text,
              category: "experience",
              mandatory: true,
              lot: null,
              deadline: null,
              rule: null,
              citations: [
                {
                  documentVersionId: chunk.documentVersionId,
                  page: chunk.page,
                  excerpt: chunk.text,
                },
              ],
            },
          ],
          summary: chunk.text,
          conflicts: [],
        };
      },
    };
    const result = await extractRequirements(chunks, model);
    expect([...visited].sort()).toEqual(["adenda", "pliego"]);
    expect(
      result.requirements.map((r) => r.citations[0].documentVersionId),
    ).toEqual(["pliego", "adenda"]);
    expect(result.requirements).toHaveLength(2);
  });

  it("keeps extraction at eight concurrent model calls by default and allows a bounded override", async () => {
    const inputs = Array.from({ length: 40 }, (_, index) => ({
      ...chunks[0],
      page: index + 1,
      text: `Page ${index + 1} contains a requirement.`,
    }));
    async function maximumConcurrency(concurrency?: number) {
      let active = 0;
      let maximum = 0;
      const result = await extractRequirements(
        inputs,
        {
          id: "test",
          generate: async (input) => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 2));
            active--;
            return {
              summary: input.evidence[0].text,
              requirements: [],
              conflicts: [],
            };
          },
        },
        undefined,
        concurrency === undefined ? undefined : { concurrency },
      );
      return { maximum, summaries: result.summaries };
    }

    const defaults = await maximumConcurrency();
    expect(defaults.maximum).toBe(8);
    expect(defaults.summaries).toEqual(inputs.map((chunk) => chunk.text));
    const configured = await maximumConcurrency(16);
    expect(configured.maximum).toBe(16);
    expect(configured.summaries).toEqual(inputs.map((chunk) => chunk.text));
  });

  it("validates extraction concurrency and defaults to eight", () => {
    expect(modelExtractionConcurrency()).toBe(8);
    expect(modelExtractionConcurrency("16")).toBe(16);
    expect(() => modelExtractionConcurrency("0")).toThrow(
      "MODEL_BUDGET_UNCONFIGURED",
    );
    expect(() => modelExtractionConcurrency("17")).toThrow(
      "MODEL_BUDGET_UNCONFIGURED",
    );
    expect(() => modelExtractionConcurrency("fast")).toThrow(
      "MODEL_BUDGET_UNCONFIGURED",
    );
  });
  it("validates joint review concurrency with a conservative default and cap", () => {
    expect(modelJointReviewConcurrency()).toBe(8);
    expect(modelJointReviewConcurrency("32")).toBe(32);
    expect(modelJointReviewConcurrency("64")).toBe(64);
    for (const value of ["0", "65", "fast", "2.5"])
      expect(() => modelJointReviewConcurrency(value)).toThrow(
        "MODEL_BUDGET_UNCONFIGURED",
      );
  });
  it("rejects uncited invented requirements instead of treating model text as evidence", async () => {
    await expect(
      extractRequirements(chunks, {
        id: "test",
        generate: async () => ({
          requirements: [
            {
              wording: "Submit bank guarantee",
              category: "guarantees",
              mandatory: true,
              lot: null,
              deadline: null,
              rule: null,
              citations: [],
            },
          ],
          summary: "x",
          conflicts: [],
        }),
      }),
    ).rejects.toThrow();
  });
});
