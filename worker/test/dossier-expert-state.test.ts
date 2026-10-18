import { it, expect } from "vitest";
import { expertFixture } from "./expert-fixture";
import {
  readExpertState,
  commitExpertEffect,
} from "../src/dossier/expert-state";
import { DossierRepository } from "../src/dossier/repository";
it("persists plans and receipts across reload without duplicate writes", async () => {
  const f = await expertFixture();
  try {
    const input: any = {
      operationId: "plan1",
      snapshot: f.snapshot,
      expectedRevision: 0,
      kind: "plan",
      value: { snapshot: f.snapshot, originatingTurnId: "request", items: [] },
    };
    const first = await commitExpertEffect(f.repo, f.scope, input);
    const retry = await commitExpertEffect(f.repo, f.scope, input);
    expect(first.duplicate).toBe(false);
    expect(retry).toEqual({ ...first, duplicate: true });
    expect(
      (
        await readExpertState(
          new DossierRepository(f.env, f.repo.context),
          f.scope,
        )
      ).plan?.revision,
    ).toBe(1);
    expect(
      (
        await readExpertState(f.repo, {
          ...f.scope,
          companyProfileId: undefined,
        })
      ).plan,
    ).toBeNull();
    const foreign = new DossierRepository(f.env, {
      ...f.repo.context,
      ownerId: "foreign",
    });
    await expect(readExpertState(foreign, f.scope)).rejects.toThrow();
  } finally {
    await f.mf.dispose();
  }
});
it("rejects stale snapshots, modified replay payloads and lost leases", async () => {
  const f = await expertFixture();
  try {
    const input: any = {
      operationId: "plan1",
      snapshot: f.snapshot,
      expectedRevision: 0,
      kind: "plan",
      value: { snapshot: f.snapshot, originatingTurnId: "request", items: [] },
    };
    await commitExpertEffect(f.repo, f.scope, input);
    await expect(
      commitExpertEffect(f.repo, f.scope, {
        ...input,
        value: { ...input.value, items: [{}] },
      }),
    ).rejects.toThrow();
    const dossier = await f.repo.readDossier(f.scope.dossierId);
    await f.repo.save(
      "dossier",
      dossier.id,
      { ...dossier.value, corpusRevision: 2 },
      dossier.revision,
    );
    expect((await readExpertState(f.repo, f.scope)).stale).toBe(true);
    await expect(
      commitExpertEffect(f.repo, f.scope, {
        ...input,
        operationId: "plan2",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "EXPERT_SNAPSHOT_CHANGED" });
    await expect(
      commitExpertEffect(f.repo, { ...f.scope, lease: "wrong" }, input),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  } finally {
    await f.mf.dispose();
  }
});
it("serializes competing plan revisions and preserves the winning value", async () => {
  const f = await expertFixture();
  try {
    const input: any = {
      snapshot: f.snapshot,
      expectedRevision: 0,
      kind: "plan",
      value: { snapshot: f.snapshot, originatingTurnId: "request", items: [] },
    };
    const outcomes = await Promise.allSettled([
      commitExpertEffect(f.repo, f.scope, { ...input, operationId: "a" }),
      commitExpertEffect(f.repo, f.scope, { ...input, operationId: "b" }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await readExpertState(f.repo, f.scope)).plan?.revision).toBe(1);
  } finally {
    await f.mf.dispose();
  }
});
