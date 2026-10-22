import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { DossierRepository } from "../src/dossier/repository";
import { synthesizeDossier } from "../src/dossier/synthesis";
import type { ModelProvider } from "../src/dossier/model";

vi.mock("../src/dossier/joint-review", () => ({
  reviewJointRequirements: async (requirements: unknown[]) => ({
    summaries: [],
    conflicts: [],
    amendments: [],
    candidateReviews: [],
    metrics: {
      requirements: requirements.length,
      blocks: 0,
      reviewGroups: 0,
      comparedPairs: 0,
      candidates: 0,
      verifiedCandidates: 0,
      completedVerifications: 0,
      reviewRequests: 0,
      verificationRequests: 0,
      maxRequestChars: 0,
    },
  }),
}));

let mf: Miniflare;
let repo: DossierRepository;
let now = Date.parse("2026-10-22T12:00:00Z");
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DOSSIER_DB"],
      r2Buckets: ["DOSSIER_FILES"],
      compatibilityDate: "2026-10-01",
    }),
  );
  const db = await mf.getD1Database("DOSSIER_DB");
  await db.exec(
    readFileSync(
      new URL("../migrations/0001_dossiers.sql", import.meta.url),
      "utf8",
    ),
  );
  repo = new DossierRepository(
    {
      DOSSIER_DB: db as unknown as D1Database,
      DOSSIER_FILES: (await mf.getR2Bucket(
        "DOSSIER_FILES",
      )) as unknown as R2Bucket,
    },
    {
      ownerId: "capacity-test-owner",
      scopes: ["dossier:read", "dossier:write", "company:write", "conversation:write"],
    },
    () => now,
  );
});
afterAll(async () => mf?.dispose());

describe("bounded synthesis result persistence", () => {
  it("persists more than 5000 deterministic requirements in bounded batches and replays from cache", async () => {
    const dossier = await repo.createOrGetDossier("CO1.REQ.90001");
    await repo.save(
      "dossier",
      dossier.id,
      {
        ...dossier.value,
        corpusRevision: 1,
        documentIds: ["capacity-document"],
        coverage: { inventoryComplete: true },
      },
      dossier.revision,
    );
    await repo.save(
      "document",
      "capacity-document",
      {
        dossierId: dossier.id,
        processId: dossier.id,
        sourceId: "capacity-source",
        name: "capacity.pdf",
        url: null,
        fileId: "capacity-document",
        corpusRevision: 1,
        state: "ready",
      },
      0,
    );
    const sourceCount = 51;
    for (let index = 0; index < sourceCount; index++) {
      await repo.save(
        "chunk",
        `capacity-chunk-${index}`,
        {
          documentVersionId: "capacity-document",
          page: index + 1,
          index,
          text: `Provide the evidence listed on source page ${index + 1}.`,
        },
        0,
      );
    }

    let modelCalls = 0;
    const model: ModelProvider = {
      id: "capacity-fixture-model",
      async generate(input) {
        modelCalls++;
        const source = input.evidence[0]!;
        const page = source.page!;
        if (source.text.trim().length < 3)
          return { summary: "", conflicts: [], requirements: [] };
        return {
          summary: `Source page ${page}.`,
          conflicts: [],
          requirements: Array.from({ length: 100 }, (_, requirementIndex) => ({
            wording: `Requirement ${requirementIndex} from page ${page}.`,
            category: "documents",
            mandatory: true,
            lot: null,
            deadline: null,
            rule: null,
            citations: [
              {
                documentVersionId: source.documentVersionId,
                page,
                excerpt: source.text,
              },
            ],
          })),
        };
      },
    };

    const firstBatchSizes: number[] = [];
    const persistFirst = repo.upsertMany.bind(repo);
    const captureFirstBatches = vi
      .spyOn(repo, "upsertMany")
      .mockImplementation(async (kind, entries) => {
        firstBatchSizes.push(entries.length);
        return persistFirst(kind, entries);
      });
    const first = await synthesizeDossier(repo, dossier.id, 1, model);
    captureFirstBatches.mockRestore();
    const firstModelCalls = modelCalls;
    expect(firstBatchSizes).toEqual(Array.from({ length: 51 }, () => 100));
    expect(first.requirementIds).toHaveLength(sourceCount * 100);
    const savedIds = await repo.db
      .prepare(
        "SELECT id FROM dossier_records WHERE owner_id=? AND kind='requirement' ORDER BY id",
      )
      .bind(repo.context.ownerId)
      .all<{ id: string }>();
    expect(savedIds.results).toHaveLength(sourceCount * 100);
    expect(new Set(savedIds.results.map((record) => record.id))).toEqual(
      new Set(first.requirementIds),
    );

    const replayBatches: string[][] = [];
    const persistReplay = vi.spyOn(repo, "upsertMany").mockImplementation(
      async (_kind, entries) => {
        replayBatches.push(entries.map((entry) => entry.id));
      },
    );
    const second = await synthesizeDossier(repo, dossier.id, 1, model);
    persistReplay.mockRestore();
    expect(second.requirementIds).toEqual(first.requirementIds);
    expect(replayBatches.flat()).toEqual(first.requirementIds);
    expect(replayBatches.every((batch) => batch.length <= 100)).toBe(true);
    expect(modelCalls).toBe(firstModelCalls);
  }, 20000);
});
