import { describe, expect, it } from "vitest";
import {
  checklistDeadlineStatus,
  renderExhaustiveChecklist,
  type ExhaustiveChecklist,
} from "../src/dossier/checklist";

describe("exhaustive checklist rendering", () => {
  it("does not present extracted numeric rules as verified facts", () => {
    const checklist: ExhaustiveChecklist = {
      dossierId: "CO1.REQ.1",
      corpusRevision: 1,
      coverage: {
        requirements: 1,
        citedRequirements: 1,
        inventoryComplete: true,
        listedDocuments: 1,
        reviewRequiredDocuments: 0,
        unavailableDocuments: 0,
      },
      items: [
        {
          reference: "R129",
          requirementId: "requirement-129",
          wording: "Acreditar mínimo dos certificaciones de experiencia.",
          category: "experience",
          mandatory: true,
          lot: null,
          deadline: null,
          deadlineStatus: null,
          rule: {
            field: "experience_years",
            operator: "gte",
            value: 2,
            unit: "years",
            period: null,
          },
          citations: [
            {
              sourceRef: "S001",
              documentVersionId: "document-1",
              documentName: "Pliego.pdf",
              page: 10,
            },
          ],
        },
      ],
      sources: [
        {
          reference: "S001",
          documentVersionId: "document-1",
          documentName: "Pliego.pdf",
          page: 10,
          excerpt: "Acreditar mínimo dos certificaciones de experiencia.",
        },
      ],
      evidenceGaps: [],
      companyEvidence: {
        profileAttached: false,
        documents: [],
        note: "No hay un perfil de empresa asociado.",
      },
      cautions: [],
    };

    const answer = renderExhaustiveChecklist(checklist);
    expect(checklist.items[0].rule).toMatchObject({
      field: "experience_years",
      operator: "gte",
      value: 2,
      unit: "years",
    });
    expect(answer).toContain("Regla numérica extraída pendiente de verificar");
    expect(answer).toContain(checklist.items[0].wording);
    expect(answer).toContain(checklist.sources[0].excerpt);
    expect(answer).not.toContain("experience_years");
    expect(answer).not.toContain("gte");
    expect(answer).not.toContain("2 years");
    checklist.items[0] = {...checklist.items[0], wording: "Presentación de ofertas", deadline: "30 de abril de 2026", deadlineStatus: "past"};
    const compact = renderExhaustiveChecklist(checklist, {includeSourceExcerpts: false});
    expect(compact).toMatch(/^## Plazo de presentación transcurrido/);
    expect(compact).toContain("[S001] Pliego.pdf (p. 10)");
    expect(compact).toContain("No se debe asumir que este proceso recibe ofertas");
  });

  it("parses Spanish deadlines through the end of the stated Bogota day", () => {
    const lastMillisecond = Date.parse("2026-05-01T04:59:59.999Z");
    expect(
      checklistDeadlineStatus(
        "30 de abril de 2026 a las 08:00",
        lastMillisecond,
      ),
    ).toBe("upcoming");
    expect(
      checklistDeadlineStatus("30 de abril de 2026", lastMillisecond + 1),
    ).toBe("past");
  });

  it("rejects invalid Spanish dates and preserves ISO date handling", () => {
    expect(
      checklistDeadlineStatus("31 de febrero de 2026", Date.now()),
    ).toBeNull();
    expect(
      checklistDeadlineStatus("2026-04-30", Date.parse("2026-05-01T00:00:00Z")),
    ).toBe("past");
  });
});
