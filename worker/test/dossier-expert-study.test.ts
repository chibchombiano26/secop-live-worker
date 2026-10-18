import { it, expect } from "vitest";
import { expertFixture } from "./expert-fixture";
import { executeExpertStudy } from "../src/dossier/expert-study";
import { readExpertState } from "../src/dossier/expert-state";
import { DossierError } from "../src/dossier/contracts";
function expertModel() {
  return {
    id: "test",
    generate: async (input: any) =>
      input.purpose === "expert_plan"
        ? { actions: ["review", "evaluate_company", "save_plan"] }
        : {
            status: "insufficient_evidence",
            reason: "No company certificates",
            missing: ["Aportar certificados de experiencia"],
            companyCitations: [],
          },
  };
}
it("evaluates and saves a sourced plan with an authoritative answer", async () => {
  const f = await expertFixture();
  try {
    await executeExpertStudy(f.repo, f.job, f.env, { model: expertModel() });
    const saved = await readExpertState(f.repo, f.scope);
    expect(saved.plan?.value.items).toHaveLength(1);
    expect(saved.plan?.value.items[0].sourceRefs).toEqual(["S001"]);
    expect(await f.repo.all("task")).toEqual([]);
    const completed = await f.repo.readJob(f.job.id);
    expect(completed.progress.stage).toBe("answered");
    const turn: any = (await f.repo.all<any>("message")).find(
      (m) => m.value.expert,
    )?.value;
    expect(turn.expert.summary).toContain("certificados");
    expect(turn.checklist.items).toHaveLength(1);
    const revision = saved.plan!.revision;
    await executeExpertStudy(f.repo, completed, f.env, {
      model: {
        id: "no-replay",
        generate: async () => {
          throw Error("must not repeat");
        },
      },
    });
    expect((await readExpertState(f.repo, f.scope)).plan?.revision).toBe(
      revision,
    );
  } finally {
    await f.mf.dispose();
  }
});
it("answers broad advice without accepting model-proposed effects", async () => {
  const f = await expertFixture(
    "Dime todos los requisitos para aplicar",
    false,
  );
  try {
    await executeExpertStudy(f.repo, f.job, f.env, { model: expertModel() });
    expect((await readExpertState(f.repo, f.scope)).plan).toBeNull();
    expect(await f.repo.all("task")).toEqual([]);
    const turn = (await f.repo.all<any>("message")).find(
      (m) => m.value.expert,
    )!.value;
    expect(turn.expert.summary).toContain("Selecciona");
  } finally {
    await f.mf.dispose();
  }
});
it("resumes a budget pause without repeating the paid planning call", async () => {
  const f = await expertFixture();
  try {
    let plans = 0,
      paused = false;
    const model = {
      id: "test",
      generate: async (input: any) => {
        if (input.purpose === "expert_plan") {
          plans++;
          return { actions: ["review", "evaluate_company", "save_plan"] };
        }
        if (!paused) {
          paused = true;
          throw new DossierError("MODEL_BUDGET_EXCEEDED", 429);
        }
        return {
          status: "insufficient_evidence",
          reason: "Missing evidence",
          missing: ["certificados"],
          companyCitations: [],
        };
      },
    };
    await expect(
      executeExpertStudy(f.repo, f.job, f.env, { model }),
    ).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
    await executeExpertStudy(f.repo, await f.repo.readJob(f.job.id), f.env, {
      model,
    });
    expect(plans).toBe(1);
    expect((await readExpertState(f.repo, f.scope)).plan?.revision).toBe(1);
  } finally {
    await f.mf.dispose();
  }
});
it("rejects an amendment arriving during assessment before saving a plan", async () => {
  const f = await expertFixture();
  try {
    const model = {
      id: "test",
      generate: async (input: any) => {
        if (input.purpose === "expert_plan")
          return { actions: ["review", "evaluate_company", "save_plan"] };
        const d = await f.repo.readDossier(f.scope.dossierId);
        await f.repo.save(
          "dossier",
          d.id,
          { ...d.value, corpusRevision: 2 },
          d.revision,
        );
        return {
          status: "insufficient_evidence",
          reason: "missing",
          missing: [],
          companyCitations: [],
        };
      },
    };
    await expect(
      executeExpertStudy(f.repo, f.job, f.env, { model }),
    ).rejects.toMatchObject({ code: "ASSESSMENT_INPUT_CHANGED" });
    expect((await readExpertState(f.repo, f.scope)).plan).toBeNull();
  } finally {
    await f.mf.dispose();
  }
});
