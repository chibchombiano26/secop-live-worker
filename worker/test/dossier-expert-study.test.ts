import { it, expect, vi } from "vitest";
import { expertFixture } from "./expert-fixture";
import { executeExpertStudy } from "../src/dossier/expert-study";
import { readExpertState } from "../src/dossier/expert-state";
import { DossierRepository } from "../src/dossier/repository";
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
  const f = await expertFixture(undefined, true, true);
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
  const f = await expertFixture(undefined, true, true);
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
  const f = await expertFixture(undefined, true, true);
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

it("never commits a new-corpus plan from an assessment finished before an amendment", async () => {
  const f = await expertFixture();
  try {
    const original = f.repo.checkpointJob.bind(f.repo);
    let amended = false;
    vi.spyOn(f.repo, "checkpointJob").mockImplementation(
      async (id, lease, progress) => {
        const result = await original(id, lease, progress);
        if (progress.stage === "expert_assessed" && !amended) {
          amended = true;
          const d = await f.repo.readDossier(f.scope.dossierId);
          const report = await f.repo.read<any>(
            "report",
            String(d.value.reportId),
          );
          const req = await f.repo.read<any>("requirement", "r1");
          await f.repo.save(
            "requirement",
            "r1",
            { ...req.value, corpusRevision: 2 },
            req.revision,
          );
          await f.repo.save(
            "report",
            `${f.scope.dossierId}:2`,
            { ...report.value, corpusRevision: 2 },
            0,
          );
          await f.repo.save(
            "dossier",
            d.id,
            { ...d.value, corpusRevision: 2, reportId: `${d.id}:2` },
            d.revision,
          );
        }
        return result;
      },
    );
    await expect(
      executeExpertStudy(f.repo, f.job, f.env, { model: expertModel() }),
    ).rejects.toMatchObject({ code: "EXPERT_SNAPSHOT_CHANGED" });
    expect((await readExpertState(f.repo, f.scope)).plan).toBeNull();
    expect(await f.repo.all("expert_receipt")).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.mf.dispose();
  }
}, 20000);
it("revalidates expiring company support when resuming a completed assessment", async () => {
  const f = await expertFixture();
  try {
    let now = Date.parse("2100-01-01T23:59:00Z");
    const repo = new DossierRepository(f.env, f.repo.context, () => now);
    await repo.db
      .prepare(
        "UPDATE dossier_jobs SET lease_until=? WHERE owner_id=? AND id=?",
      )
      .bind(now + 600000, f.scope.ownerId, f.job.id)
      .run();
    await repo.save(
      "document",
      "expiring",
      {
        dossierId: "company:company-a",
        name: "Experience.pdf",
        state: "ready",
        expiresOn: "2100-01-01",
      },
      0,
    );
    await repo.save(
      "evidence",
      "expiring",
      { companyId: "company-a", documentId: "expiring" },
      0,
    );
    await repo.save(
      "chunk",
      "expiring",
      {
        documentVersionId: "expiring",
        index: 0,
        page: 1,
        text: "Two contracts",
      },
      0,
    );
    const model = {
      id: "test",
      generate: async (input: any) =>
        input.purpose === "expert_plan"
          ? { actions: ["review", "evaluate_company", "save_plan"] }
          : {
              status: "meets",
              reason: "Two contracts",
              missing: [],
              companyCitations: [
                {
                  documentVersionId: "expiring",
                  page: 1,
                  excerpt: "Two contracts",
                },
              ],
            },
    };
    const original = repo.checkpointJob.bind(repo);
    let paused = false;
    vi.spyOn(repo, "checkpointJob").mockImplementation(
      async (id, lease, progress) => {
        const result = await original(id, lease, progress);
        if (progress.stage === "expert_assessed" && !paused) {
          paused = true;
          throw new DossierError("MODEL_BUDGET_EXCEEDED", 429);
        }
        return result;
      },
    );
    await expect(
      executeExpertStudy(repo, f.job, f.env, { model }),
    ).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
    now += 90000;
    await executeExpertStudy(repo, await repo.readJob(f.job.id), f.env, {
      model,
    });
    const plan = (await readExpertState(repo, f.scope)).plan!;
    expect(plan.value.items).toHaveLength(1);
    expect(plan.value.items[0].status).toBe("insufficient_evidence");
  } finally {
    vi.restoreAllMocks();
    await f.mf.dispose();
  }
}, 20000);
it("recovers explicit user decisions as assertions without approving company facts", async () => {
  const f = await expertFixture(
    "Recuerda que revisaremos todos los requisitos antes de participar",
  );
  try {
    const model = {
      id: "test",
      generate: async () => ({ actions: ["review", "remember_decision"] }),
    };
    await executeExpertStudy(f.repo, f.job, f.env, { model });
    const state = await readExpertState(
      new DossierRepository(f.env, f.repo.context),
      f.scope,
    );
    expect(state.memory?.value.decisions).toEqual([
      {
        text: "Recuerda que revisaremos todos los requisitos antes de participar",
        originatingTurnId: "request",
      },
    ]);
    expect(
      (await f.repo.read<any>("company", "company-a")).value.facts,
    ).toEqual([]);
    expect(
      (
        await readExpertState(f.repo, {
          ...f.scope,
          companyProfileId: undefined,
        })
      ).memory,
    ).toBeNull();
    await executeExpertStudy(f.repo, await f.repo.readJob(f.job.id), f.env, {
      model,
    });
    expect((await readExpertState(f.repo, f.scope)).memory?.revision).toBe(1);
  } finally {
    await f.mf.dispose();
  }
}, 20000);
