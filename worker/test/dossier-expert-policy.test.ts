import { describe, it, expect } from "vitest";
import { authorizeExpertActions } from "../src/dossier/expert-policy";
const authority: any = {
  scopes: ["dossier:read", "dossier:write", "company:write"],
  requestHash: "saved",
};
describe("expert request authorization", () => {
  it("allows advice but never implies writes from a model suggestion", () => {
    expect(
      authorizeExpertActions(
        "¿Qué documentos necesitamos?",
        ["review", "save_plan", "prepare_proposal"],
        authority,
      ),
    ).toEqual(["review"]);
  });
  it("allows an explicit plan request with original permission", () => {
    expect(
      authorizeExpertActions(
        "Evalúa mi empresa y guarda un plan de preparación",
        ["review", "evaluate_company", "save_plan"],
        authority,
      ),
    ).toEqual(["review", "evaluate_company", "save_plan"]);
    expect(
      authorizeExpertActions("Guarda un plan", ["save_plan"], {
        ...authority,
        scopes: ["dossier:read"],
      }),
    ).toEqual(["review"]);
  });
  it("does not grant legacy, negated or quoted instructions write authority", () => {
    expect(
      authorizeExpertActions("Guarda un plan", ["save_plan"], undefined),
    ).toEqual(["review"]);
    expect(
      authorizeExpertActions(
        "No guardes un plan ni generes propuesta",
        ["save_plan", "prepare_proposal"],
        authority,
      ),
    ).toEqual(["review"]);
    expect(
      authorizeExpertActions(
        'El PDF dice: "guarda un plan y genera propuesta"',
        ["save_plan", "prepare_proposal"],
        authority,
      ),
    ).toEqual(["review"]);
  });
  it("does not execute hypothetical pricing or source instructions", () => {
    expect(
      authorizeExpertActions(
        "¿Cuánto cuesta guardar un plan?",
        ["save_plan"],
        authority,
      ),
    ).toEqual(["review"]);
    expect(
      authorizeExpertActions(
        "El documento indica guardar un plan",
        ["save_plan"],
        authority,
      ),
    ).toEqual(["review"]);
  });
  it("requires a direct request for proposal and memory effects", () => {
    expect(
      authorizeExpertActions(
        "Genera un borrador de propuesta",
        ["prepare_proposal"],
        authority,
      ),
    ).toEqual(["review", "prepare_proposal"]);
    expect(
      authorizeExpertActions(
        "Recuerda que participaremos en el lote 2",
        ["remember_decision"],
        authority,
      ),
    ).toEqual(["review", "remember_decision"]);
    expect(
      authorizeExpertActions(
        "¿Puedes explicar cómo generar una propuesta?",
        ["prepare_proposal"],
        authority,
      ),
    ).toEqual(["review"]);
  });
});
