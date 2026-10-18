import { it, expect } from "vitest";
import { expertFixture } from "./expert-fixture";
import { executeExpertStudy } from "../src/dossier/expert-study";
import { executePrivateOperation } from "../src/dossier/api";
it("reloads the saved expert plan through the existing assistant contract", async () => {
  const f = await expertFixture(undefined, true, true);
  try {
    const model = {
      id: "test",
      generate: async (input: any) =>
        input.purpose === "expert_plan"
          ? { actions: ["review", "evaluate_company", "save_plan"] }
          : {
              status: "insufficient_evidence",
              reason: "No certificates",
              missing: ["Aportar certificados"],
              companyCitations: [],
            },
    };
    await executeExpertStudy(f.repo, f.job, f.env, { model });
    await f.repo.completeJob(f.job.id, f.scope.lease);
    const response: any = await executePrivateOperation(
      f.env,
      f.repo.context,
      "assistant",
      {
        context: {
          dossierId: f.scope.dossierId,
          companyProfileId: f.scope.companyProfileId,
        },
        request: { method: "load" },
      },
      "https://test.invalid",
    );
    expect(response.messages[1].text).toContain("Plan de preparación guardado");
    expect(response.messages[1].text).toContain("Aportar certificados");
    expect(response.messages[1].taskSuggestions[0]).toMatchObject({
      id: "r1",
      citationIds: ["S001"],
    });
    expect(response.documentActions[0].id).toBe("proposal-docx");
  } finally {
    await f.mf.dispose();
  }
}, 20000);
it("keeps company evidence citations openable only for the selected company", async () => {
  const f = await expertFixture();
  try {
    await f.repo.putFile(
      "company-pdf",
      new TextEncoder().encode("%PDF-1.4\ncompany"),
      "application/pdf",
    );
    await f.repo.save(
      "document",
      "company-doc",
      {
        dossierId: "company:company-a",
        name: "Experiencia empresa.pdf",
        state: "ready",
        fileId: "company-pdf",
      },
      0,
    );
    await f.repo.save(
      "evidence",
      "company-evidence",
      { companyId: "company-a", documentId: "company-doc" },
      0,
    );
    await f.repo.save(
      "chunk",
      "company-chunk",
      {
        documentVersionId: "company-doc",
        index: 0,
        page: 1,
        text: "Un contrato acreditado",
      },
      0,
    );
    const model = {
      id: "test",
      generate: async (input: any) =>
        input.purpose === "expert_plan"
          ? { actions: ["review", "evaluate_company", "save_plan"] }
          : {
              status: "does_not_meet",
              reason: "Solo un contrato acreditado",
              missing: ["Aportar otro contrato"],
              companyCitations: [
                {
                  documentVersionId: "company-doc",
                  page: 1,
                  excerpt: "Un contrato acreditado",
                },
              ],
            },
    };
    await executeExpertStudy(f.repo, f.job, f.env, { model });
    await f.repo.completeJob(f.job.id, f.scope.lease);
    const context = {
      dossierId: f.scope.dossierId,
      companyProfileId: "company-a",
    };
    const response: any = await executePrivateOperation(
      f.env,
      f.repo.context,
      "assistant",
      { context, request: { method: "load" } },
      "https://test.invalid",
    );
    expect(response.messages[1].citations[1]).toMatchObject({
      id: "S002",
      label: "Experiencia empresa.pdf · pág. 1",
      canOpen: true,
    });
    const opened: any = await executePrivateOperation(
      f.env,
      f.repo.context,
      "assistant",
      {
        context,
        request: {
          method: "open-source",
          messageId: response.messages[1].id,
          citationId: "S002",
        },
      },
      "https://test.invalid",
    );
    expect(opened.source.url).toContain("#page=1");
    await f.repo.save(
      "company",
      "other-company",
      { name: "Other", activities: "", facts: [] },
      0,
    );
    await expect(
      executePrivateOperation(
        f.env,
        f.repo.context,
        "assistant",
        {
          context: { ...context, companyProfileId: "other-company" },
          request: {
            method: "open-source",
            messageId: response.messages[1].id,
            citationId: "S002",
          },
        },
        "https://test.invalid",
      ),
    ).rejects.toThrow();
  } finally {
    await f.mf.dispose();
  }
}, 20000);
