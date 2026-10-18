import { it, expect } from "vitest";
import { expertFixture } from "./expert-fixture";
import { createExpertTools } from "../src/dossier/expert-tools";
import { assessCompany } from "../src/dossier/assessment";
const model: any = {
  id: "test",
  generate: async () => ({
    status: "insufficient_evidence",
    reason: "No company evidence",
    missing: ["Aportar dos certificados"],
    companyCitations: [],
  }),
};
it("reviews every sourced requirement and evaluates without creating tasks", async () => {
  const f = await expertFixture();
  try {
    const tools = createExpertTools(f.repo, f.scope, model);
    const review = await tools.reviewRequirements();
    expect(review.items.map((i) => i.requirementId)).toEqual(["r1"]);
    expect(review.sources[0].page).toBe(2);
    const assessment = await tools.evaluateCompany();
    expect(assessment?.findings[0].status).toBe("insufficient_evidence");
    expect(await f.repo.all("task")).toEqual([]);
    const plan = await tools.buildPreparationPlan();
    expect(plan.items[0]).toMatchObject({
      requirementId: "r1",
      sourceRefs: ["S001"],
      owner: null,
      dueDate: null,
      status: "insufficient_evidence",
    });
    await tools.savePlan(plan, "test-plan", 0);
    await expect(
      tools.savePlan(
        { ...plan, items: [{ ...plan.items[0], requirementId: "foreign" }] },
        "foreign",
        1,
      ),
    ).rejects.toThrow();
  } finally {
    await f.mf.dispose();
  }
});
it("reports a missing company and never selects one silently", async () => {
  const f = await expertFixture("Guarda un plan", false);
  try {
    const tools = createExpertTools(f.repo, f.scope, model);
    expect(await tools.evaluateCompany()).toBeNull();
    expect((await tools.buildPreparationPlan()).items[0].status).toBe(
      "insufficient_evidence",
    );
  } finally {
    await f.mf.dispose();
  }
});
it("repeated assessment preserves edited task owner date and state", async () => {
  const f = await expertFixture();
  try {
    const result = await assessCompany(
      f.repo,
      f.scope.dossierId,
      "company-a",
      [],
      model,
    );
    const task = (await f.repo.all<any>("task"))[0];
    await f.repo.save(
      "task",
      task.id,
      {
        ...task.value,
        owner: "Jose",
        dueDate: "2026-12-01",
        state: "in_progress",
      },
      task.revision,
    );
    await assessCompany(f.repo, f.scope.dossierId, "company-a", [], model);
    expect((await f.repo.read<any>("task", task.id)).value).toMatchObject({
      owner: "Jose",
      dueDate: "2026-12-01",
      state: "in_progress",
    });
  } finally {
    await f.mf.dispose();
  }
});
it("does not approve company support whose OCR still needs review", async () => {
  const f = await expertFixture();
  try {
    await f.repo.save(
      "document",
      "company-doc",
      {
        dossierId: "company:company-a",
        name: "Company.pdf",
        state: "review_required",
      },
      0,
    );
    await f.repo.save(
      "evidence",
      "e1",
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
        text: "Two contracts",
      },
      0,
    );
    const optimistic: any = {
      id: "optimistic",
      generate: async () => ({
        status: "meets",
        reason: "Two contracts",
        missing: [],
        companyCitations: [
          {
            documentVersionId: "company-doc",
            page: 1,
            excerpt: "Two contracts",
          },
        ],
      }),
    };
    const finding = await createExpertTools(
      f.repo,
      f.scope,
      optimistic,
    ).evaluateCompany();
    expect(finding?.findings[0].status).toBe("insufficient_evidence");
  } finally {
    await f.mf.dispose();
  }
});
it("evaluates every requirement without model charges when the company has no extracted evidence", async () => {
  const f = await expertFixture();
  try {
    let calls = 0;
    const result = await assessCompany(
      f.repo,
      f.scope.dossierId,
      "company-a",
      [],
      {
        id: "empty-evidence-test",
        generate: async () => {
          calls++;
          return {
            status: "meets",
            reason: "Unsupported profile assertion",
            missing: [],
            companyCitations: [],
          };
        },
      },
      { createTasks: false },
    );
    expect(calls).toBe(0);
    expect(result.findings.map((x) => x.requirementId)).toEqual(["r1"]);
    expect(
      result.findings.every((x) => x.status === "insufficient_evidence"),
    ).toBe(true);
    expect(result.findings[0].missing.length).toBeGreaterThan(0);
    expect(await f.repo.all("task")).toEqual([]);
  } finally {
    await f.mf.dispose();
  }
});
it("downgrades a cached finding when its company evidence becomes unavailable", async () => {
  const f = await expertFixture(undefined, true, true);
  try {
    const text = "The company provides two software delivery contracts.";
    const chunk = await f.repo.read<any>("chunk", "fixture-company-chunk");
    await f.repo.save(
      "chunk",
      chunk.id,
      { ...chunk.value, text },
      chunk.revision,
    );
    let calls = 0;
    const supportedModel = {
      id: "evidence-loss-test",
      generate: async () => {
        calls++;
        return {
          status: "meets",
          reason: "Two supported contracts",
          missing: [],
          companyCitations: [
            {
              documentVersionId: "fixture-company-doc",
              page: 1,
              excerpt: text,
            },
          ],
        };
      },
    };
    const before = await assessCompany(
      f.repo,
      f.scope.dossierId,
      "company-a",
      [],
      supportedModel,
      { createTasks: false },
    );
    expect(before.findings[0].status).toBe("meets");
    const doc = await f.repo.read<any>("document", "fixture-company-doc");
    await f.repo.save(
      "document",
      doc.id,
      { ...doc.value, state: "failed" },
      doc.revision,
    );
    const after = await assessCompany(
      f.repo,
      f.scope.dossierId,
      "company-a",
      [],
      supportedModel,
      { createTasks: false },
    );
    expect(after.findings[0].status).toBe("insufficient_evidence");
    expect(after.findings[0].missing.length).toBeGreaterThan(0);
    expect(calls).toBe(1);
  } finally {
    await f.mf.dispose();
  }
});
