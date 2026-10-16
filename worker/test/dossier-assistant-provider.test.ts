import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { DossierRepository } from "../src/dossier/repository";
import { executePrivateOperation } from "../src/dossier/api";
let mf: Miniflare, env: any, repo: DossierRepository;
const context: any = {
  ownerId: "native-chat-test",
  scopes: ["dossier:read", "conversation:write"],
};
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
  env = {
    DOSSIER_DB: await mf.getD1Database("DOSSIER_DB"),
    DOSSIER_FILES: await mf.getR2Bucket("DOSSIER_FILES"),
  };
  await env.DOSSIER_DB.exec(
    readFileSync(
      new URL("../migrations/0001_dossiers.sql", import.meta.url),
      "utf8",
    ),
  );
  repo = new DossierRepository(env, context);
  await repo.save(
    "dossier",
    "CO1.REQ.1",
    {
      corpusRevision: 6,
      reportId: "report",
      needsSynthesis: false,
      coverage: { inventoryComplete: true },
    },
    0,
  );
  await repo.save(
    "report",
    "report",
    {
      dossierId: "CO1.REQ.1",
      corpusRevision: 6,
      coverage: { total: 1, indexed: 1, pending: [], reviewRequired: ["doc"] },
    },
    0,
  );
  await repo.save(
    "document",
    "doc",
    {
      dossierId: "CO1.REQ.1",
      name: "Estudios previos",
      state: "review_required",
    },
    0,
  );
  await repo.save(
    "conversation",
    "conversation",
    { dossierId: "CO1.REQ.1", title: "Test", turnIds: ["turn"] },
    0,
  );
  await repo.save(
    "message",
    "turn",
    {
      userMessage: "Requisitos",
      answer: "Mínimo dos certificaciones.",
      corpusRevision: 6,
      companyRevision: null,
      citations: [
        {
          documentVersionId: "doc",
          page: 3,
          excerpt: "mínimo dos (2) certificaciones",
        },
      ],
    },
    0,
  );
});
afterAll(async () => mf.dispose());
function call(input: any, actor = context) {
  return executePrivateOperation(
    env,
    actor,
    "assistant" as any,
    input,
    "https://test.invalid",
  ) as Promise<any>;
}
describe("native assistant private provider", () => {
  it("loads the same persisted conversation with human source labels and OCR coverage", async () => {
    const r = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: { method: "load" },
    });
    expect(r.conversationId).toBe("conversation");
    expect(r.messages.map((x: any) => x.role)).toEqual(["user", "assistant"]);
    expect(r.messages[1].citations[0]).toMatchObject({
      label: "Estudios previos · pág. 3",
      excerpt: "mínimo dos (2) certificaciones",
    });
    expect(r.coverage.complete).toBe(false);
    expect(r.coverage.label).toContain("1 extracción");
  });
  it("returns all pages of the selected conversation for complete transcript copying", async () => {
    const turnIds = Array.from({length: 23}, (_, i) => `history-${i}`);
    for (const [i, turnId] of turnIds.entries()) await repo.save("message", turnId, {
      userMessage: `Question ${i}`, answer: `Answer ${i}`, citations: [], corpusRevision: 6, companyRevision: null,
    }, 0);
    const current = await repo.read<any>("conversation", "conversation");
    await repo.save("conversation", "conversation", {...current.value, turnIds}, current.revision);
    const result = await call({context: {dossierId: "CO1.REQ.1"}, request: {method: "load"}});
    expect(result.messages).toHaveLength(46);
    expect(result.messages[0].text).toBe("Question 0");
    expect(result.messages.at(-1).text).toBe("Answer 22");
    const changed = await repo.read<any>("conversation", "conversation");
    await repo.save("conversation", "conversation", {...changed.value, turnIds: ["turn"]}, changed.revision);
  });
  it("rejects a conversation reference from another tender", async () => {
    await expect(
      call({
        context: { dossierId: "CO1.REQ.1" },
        request: {
          method: "send",
          conversationId: "other",
          expectedRevision: 1,
          message: "Pregunta",
          idempotencyKey: "native-request-1",
        },
      }),
    ).rejects.toBeDefined();
  });
  it("does not expose the same dossier to another owner", async () => {
    await expect(
      call(
        { context: { dossierId: "CO1.REQ.1" }, request: { method: "load" } },
        { ...context, ownerId: "other-owner" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("cannot send with read-only scopes", async () => {
    await expect(
      call(
        {
          context: { dossierId: "CO1.REQ.1" },
          request: {
            method: "send",
            conversationId: "conversation",
            expectedRevision: 1,
            message: "Pregunta",
            idempotencyKey: "native-request-2",
          },
        },
        { ...context, scopes: ["dossier:read"] },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("never labels a missing or stale report complete", async () => {
    await repo.save("dossier", "CO1.REQ.3", { corpusRevision: 2 }, 0);
    const missing = await call({
      context: { dossierId: "CO1.REQ.3" },
      request: { method: "load" },
    });
    expect(missing.coverage.complete).toBe(false);
    expect(missing.coverage.label).not.toContain("completado");
    await repo.upsert("dossier", "CO1.REQ.3", {
      corpusRevision: 2,
      reportId: "report",
      coverage: { inventoryComplete: true },
    });
    const stale = await call({
      context: { dossierId: "CO1.REQ.3" },
      request: { method: "load" },
    });
    expect(stale.coverage.complete).toBe(false);
  });
  it("keeps an explicit conversation when a newer conversation exists", async () => {
    await repo.save(
      "conversation",
      "newer",
      { dossierId: "CO1.REQ.1", title: "Newer", turnIds: [] },
      0,
    );
    await env.DOSSIER_DB.prepare(
      "UPDATE dossier_records SET updated_at=updated_at+10000 WHERE id='newer'",
    ).run();
    const sent = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: {
        method: "send",
        conversationId: "conversation",
        expectedRevision: 1,
        message: "Pregunta de prueba",
        idempotencyKey: "native-correlated-4",
      },
    });
    expect(sent.conversationId).toBe("conversation");
    const polled = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: { method: "poll", jobId: sent.pendingJobId },
    });
    expect(polled.conversationId).toBe("conversation");
  });
  it("queues a context-bound message and only polls its own tender job", async () => {
    const r = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: {
        method: "send",
        conversationId: "conversation",
        expectedRevision: 1,
        message: "Lista completa de todos los requisitos",
        idempotencyKey: "native-request-3",
      },
    });
    expect(r.pendingJobId).toBeTruthy();
    expect(
      (
        await call({
          context: { dossierId: "CO1.REQ.1" },
          request: { method: "load" },
        })
      ).pendingJobId,
    ).toBe(r.pendingJobId);
    const own = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: { method: "poll", jobId: r.pendingJobId },
    });
    expect(own.pendingJobId).toBe(r.pendingJobId);
    await repo.save("dossier", "CO1.REQ.2", { corpusRevision: 1 }, 0);
    await expect(
      call({
        context: { dossierId: "CO1.REQ.2" },
        request: { method: "poll", jobId: r.pendingJobId },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
