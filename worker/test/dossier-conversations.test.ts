import { describe, it, expect } from "vitest";
import { retrieveEvidence, validateAnswer } from "../src/dossier/conversations";
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
