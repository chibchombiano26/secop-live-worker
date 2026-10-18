import { it, expect } from "vitest";
import { expertFixture } from "./expert-fixture";
import { agentScopeId } from "../src/dossier/agent-scope";
import { budgetAgentInference } from "../src/dossier/agent-budget";
it("bounds actual Flue inference calls and rejects unrelated agents", async () => {
  const f = await expertFixture();
  try {
    const id = await agentScopeId(f.scope.ownerId, f.scope.dossierId);
    await f.repo.checkpointJob(f.job.id, f.scope.lease, { agentId: id });
    await expect(budgetAgentInference(f.env, "foreign")).rejects.toThrow();
    for (let i = 0; i < 8; i++) await budgetAgentInference(f.env, id);
    await expect(budgetAgentInference(f.env, id)).rejects.toMatchObject({
      code: "OWNER_RATE_LIMIT",
    });
    expect(
      (
        await f.repo.db
          .prepare(
            "SELECT count FROM dossier_limits WHERE owner_id=? AND bucket LIKE 'model-daily:%'",
          )
          .bind(f.scope.ownerId)
          .first<any>()
      )?.count,
    ).toBe(8);
  } finally {
    await f.mf.dispose();
  }
});
