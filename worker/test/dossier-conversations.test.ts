import { describe, it, expect } from "vitest";
import {
  retrieveEvidence,
  validateAnswer,
  generateGroundedAnswer,
  generateDossierAnswer,
  needsCorpusReview,
} from "../src/dossier/conversations";
import { isExhaustiveChecklistRequest } from "../src/dossier/checklist";
const chunks: any[] = [
  {
    documentVersionId: "pliego",
    page: 1,
    text: "Se requieren tres contratos de experiencia.",
    index: 0,
  },
  {
    documentVersionId: "finanzas",
    page: 2,
    text: "Índice de liquidez mínimo: 1.5.",
    index: 1,
  },
  {
    documentVersionId: "otro",
    page: 1,
    text: "Documento no relacionado.",
    index: 2,
  },
];
describe("grounded tender conversation", () => {
  it("uses complete corpus review for preparation questions and hybrid search for focused follow-ups", () => {
    expect(needsCorpusReview("¿Qué necesitamos para aplicar?")).toBe(true);
    expect(needsCorpusReview("Resume experiencia, documentos y cierre")).toBe(
      true,
    );
    expect(needsCorpusReview("¿Cuál es el índice mínimo de liquidez?")).toBe(
      false,
    );
    expect(
      needsCorpusReview("¿Cuántas certificaciones de experiencia se piden?"),
    ).toBe(false);
  });
  it("routes explicit exhaustive requirement requests to the complete checklist", () => {
    expect(
      isExhaustiveChecklistRequest("Enumera todos los requisitos del pliego"),
    ).toBe(true);
    expect(
      isExhaustiveChecklistRequest("Give me every requirement as a checklist"),
    ).toBe(true);
    expect(
      isExhaustiveChecklistRequest("Make a checklist of requirements"),
    ).toBe(true);
    expect(isExhaustiveChecklistRequest("What experience is required?")).toBe(
      false,
    );
  });
  it("does not present an uncited retrieval miss as proof that a requirement is absent", () => {
    const result = validateAnswer(
      {
        answer:
          "No se especifica la cantidad de certificaciones y no incluye detalles de recibido.",
        insufficientEvidence: true,
        citations: [],
      },
      chunks,
    );
    expect(result.answer).not.toContain("No se especifica");
    expect(result.answer).toContain("no demuestra que el requisito no exista");
  });
  it("constrains chat citations to real sources and bounds duplicated source/schema context", async () => {
    let sent: any;
    const evidence = Array.from({ length: 9 }, (_, index) => ({
      documentVersionId: `doc-${index}`,
      page: index + 1,
      index,
      text: Array.from(
        { length: 500 },
        (_, word) => `Real source ${index} word ${word}. `,
      )
        .join("")
        .slice(0, 4000),
    }));
    await generateGroundedAnswer(
      {
        id: "test",
        generate: async (input) => {
          sent = input;
          return {
            answer: "The available sources need review.",
            insufficientEvidence: true,
            citations: [],
          };
        },
      },
      { purpose: "test", evidence, instructions: "Answer from evidence" },
    );
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(48000);
    const options = sent.outputSchema.properties.citations.items.anyOf;
    expect(
      options.every((source: any) =>
        source.properties.documentVersionId.const.startsWith("doc-"),
      ),
    ).toBe(true);
    expect(
      options.every((source: any) => source.properties.excerpt.enum.length > 0),
    ).toBe(true);
    expect(sent.context.retrievalCoverage.omittedSources).toBeGreaterThan(0);
    expect(sent.evidence.length).toBeGreaterThan(0);
  });

  it("passes every current source without duplicating excerpts in the citation schema", async () => {
    let sent: any;
    const evidence = Array.from({ length: 37 }, (_, i) => ({
      documentVersionId: `document-${i}`,
      page: i + 1,
      index: i,
      text: `Requirement ${i}: ` + "original evidence ".repeat(35),
    }));
    await generateDossierAnswer(
      {
        id: "test",
        generate: async (input) => {
          sent = input;
          return {
            answer: "Review pending",
            insufficientEvidence: true,
            citations: [],
          };
        },
      },
      {
        purpose: "tender_conversation",
        evidence,
        instructions: "Use all sources",
      },
    );
    expect(sent.evidence).toHaveLength(37);
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(48000);
    expect(sent.context.retrievalCoverage).toMatchObject({
      selectedSources: 37,
      omittedSources: 0,
    });
    expect(JSON.stringify(sent.outputSchema)).not.toContain(
      "original evidence",
    );
  });
  it("reads all large-corpus blocks and grounds synthesis only in verified original excerpts", async () => {
    const evidence = Array.from({ length: 8 }, (_, i) => ({
      documentVersionId: `doc-${i}`,
      page: 1,
      index: i,
      text: `Unique obligation ${i}. ` + "source material ".repeat(1200),
    }));
    const visited = new Set<string>();
    let synthesis: any;
    const result = await generateDossierAnswer(
      {
        id: "test",
        generate: async (input) => {
          for (const c of input.evidence) visited.add(c.documentVersionId);
          if (input.purpose === "tender_conversation") synthesis = input;
          return {
            answer: input.evidence.map((c) => c.text.split(". ")[0]).join("; "),
            insufficientEvidence: false,
            citations: input.evidence.map((c, i) => ({
              sourceRef: `E${i + 1}.1`,
            })),
          };
        },
      },
      {
        purpose: "tender_conversation",
        evidence,
        instructions: "Use all sources",
      },
    );
    expect(visited.size).toBe(8);
    expect(synthesis.context.corpusCoverage).toMatchObject({
      sourceChunksTotal: 8,
      sourceChunksReviewed: 8,
    });
    expect(result.citations.map((c) => c.documentVersionId)).toEqual(
      evidence.map((c) => c.documentVersionId),
    );
    expect(
      synthesis.evidence.every(
        (c: any) => c.text.includes("Unique obligation") && c.text.length < 600,
      ),
    ).toBe(true);
  });

  it("synthesizes every verified block quotation without duplicating long unverified model narratives", async () => {
    const evidence = Array.from({ length: 18 }, (_, i) => ({
      documentVersionId: `doc-${i}`,
      page: 1,
      index: i,
      text: `Obligation ${i}. ` + "original requirement ".repeat(300),
    }));
    let final: any;
    await generateDossierAnswer(
      {
        id: "test",
        generate: async (input) => {
          if (input.purpose === "tender_conversation") final = input;
          return {
            answer:
              input.purpose === "tender_conversation"
                ? "Synthesis"
                : "Narrative ".repeat(1700),
            insufficientEvidence: false,
            citations: input.evidence.map((_, i) => ({
              sourceRef: `E${i + 1}.1`,
            })),
          };
        },
      },
      { purpose: "tender_conversation", evidence, instructions: "Answer" },
    );
    expect(
      new Set(final.evidence.map((c: any) => c.documentVersionId)).size,
    ).toBe(18);
    expect(JSON.stringify(final).length).toBeLessThanOrEqual(48000);
    expect(JSON.stringify(final.context)).not.toContain("Narrative Narrative");
  });
  it("resolves source span references to exact original quotes without model-generated excerpts", async () => {
    let sent: any;
    const original =
      "Primera obligación. " + "Requisito contractual. ".repeat(70);
    const result = await generateDossierAnswer(
      {
        id: "test",
        generate: async (input) => {
          sent = input;
          return {
            answer: "Condición [E1.2]",
            insufficientEvidence: false,
            citations: [{ sourceRef: "E1.2" }],
          };
        },
      },
      {
        purpose: "test",
        evidence: [
          { documentVersionId: "doc", page: 3, index: 0, text: original },
        ],
        instructions: "Answer",
      },
    );
    expect(original).toContain(result.citations[0].excerpt);
    expect(result.citations[0].page).toBe(3);
    expect(result.answer).toBe("Condición [S001]");
    expect(
      sent.outputSchema.properties.citations.items.properties,
    ).not.toHaveProperty("excerpt");
    const recovered = sent.evidence[0].text.replace(/\[E\d+\.\d+\] /g, "");
    expect(recovered).toBe(original);
  });
  it("keeps preceding context when an experience clause crosses a reference boundary", async () => {
    const original =
      "Introducción. ".repeat(32) +
      "Mínimo dos (2) certificaciones y/o facturas que acrediten recibido a satisfacción. " +
      "Condiciones. ".repeat(50);
    const result = await generateDossierAnswer(
      {
        id: "test",
        generate: async () => ({
          answer: "Dos certificaciones",
          insufficientEvidence: false,
          citations: [{ sourceRef: "E1.2" }],
        }),
      },
      {
        purpose: "test",
        evidence: [
          { documentVersionId: "doc", index: 0, page: 3, text: original },
        ],
        instructions: "Answer",
      },
    );
    expect(result.citations[0].excerpt).toContain("Mínimo dos (2)");
    expect(result.citations[0].excerpt).toContain("recibido a satisfacción");
    expect(original).toContain(result.citations[0].excerpt);
  });
  it("returns canonical source whitespace for citations used by corpus synthesis", async () => {
    const result = await generateDossierAnswer(
      {
        id: "test",
        generate: async () => ({
          answer: "Dos",
          insufficientEvidence: false,
          citations: [
            { sourceRef: "E1", excerpt: "mínimo dos certificaciones" },
          ],
        }),
      },
      {
        purpose: "test",
        evidence: [
          {
            documentVersionId: "doc",
            index: 0,
            page: 1,
            text: "Se exigen mínimo dos\ncertificaciones.",
          },
        ],
        instructions: "Answer",
      },
    );
    expect(result.citations[0].excerpt).toBe("mínimo dos\ncertificaciones");
  });
  it("repairs malformed reference output and rejects foreign source references", async () => {
    let calls = 0;
    const result = await generateDossierAnswer(
      {
        id: "test",
        generate: async () => ({
          answer: "Tres contratos",
          insufficientEvidence: false,
          citations:
            ++calls === 1
              ? [{ documentVersionId: "pliego", excerpt: "tres contratos" }]
              : [{ sourceRef: "E1", excerpt: "tres contratos" }],
        }),
      },
      { purpose: "test", evidence: chunks, instructions: "Answer" },
    );
    expect(calls).toBe(2);
    expect(result.citations[0].documentVersionId).toBe("pliego");
    await expect(
      generateDossierAnswer(
        {
          id: "test",
          generate: async () => ({
            answer: "Foreign",
            insufficientEvidence: false,
            citations: [{ sourceRef: "E999", excerpt: "foreign text" }],
          }),
        },
        { purpose: "test", evidence: chunks, instructions: "Answer" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CITATION" });
  });
  it("repairs a discontiguous quotation before storing an answer", async () => {
    let calls = 0;
    const model = {
      id: "test",
      generate: async () => ({
        answer: "Requiere experiencia.",
        insufficientEvidence: false,
        citations: [
          {
            documentVersionId: "pliego",
            page: 1,
            excerpt:
              ++calls === 1
                ? "Se requieren tres contratos. experiencia."
                : "tres contratos de experiencia",
          },
        ],
      }),
    };
    const result = await generateGroundedAnswer(model, {
      purpose: "test",
      evidence: chunks,
      instructions: "Answer with citations",
    });
    expect(calls).toBe(2);
    expect(result.citations[0].excerpt).toBe("tres contratos de experiencia");
  });
  it("ranks the question against original evidence", () => {
    expect(
      retrieveEvidence(chunks, "¿Cuál es el índice mínimo de liquidez?")[0]
        .documentVersionId,
    ).toBe("finanzas");
  });
  it("requires valid citations unless explicitly answering insufficient evidence", () => {
    expect(
      validateAnswer(
        {
          answer: "No consta ese requisito.",
          insufficientEvidence: true,
          citations: [],
        },
        chunks,
      ).insufficientEvidence,
    ).toBe(true);
    expect(() =>
      validateAnswer(
        {
          answer: "La liquidez es 3.",
          insufficientEvidence: false,
          citations: [],
        },
        chunks,
      ),
    ).toThrow();
    expect(() =>
      validateAnswer(
        {
          answer: "La liquidez es 3.",
          insufficientEvidence: false,
          citations: [
            {
              documentVersionId: "finanzas",
              page: 9,
              excerpt: "liquidez mínimo: 1.5",
            },
          ],
        },
        chunks,
      ),
    ).toThrow();
    expect(
      validateAnswer(
        {
          answer: "La liquidez mínima es 1.5.",
          insufficientEvidence: false,
          citations: [
            {
              documentVersionId: "finanzas",
              page: 2,
              excerpt: "liquidez mínimo: 1.5",
            },
          ],
        },
        chunks,
      ).citations,
    ).toHaveLength(1);
  });
});
