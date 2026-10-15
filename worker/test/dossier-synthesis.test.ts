import { describe, it, expect } from "vitest";
import {
  validateCitations,
  extractRequirements,
} from "../src/dossier/synthesis";
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
    expect(visited).toEqual(["pliego", "adenda"]);
    expect(result.requirements).toHaveLength(2);
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
