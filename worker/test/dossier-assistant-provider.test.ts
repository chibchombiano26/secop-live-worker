import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { DossierRepository } from "../src/dossier/repository";
import { executePrivateOperation, privateApiRequest } from "../src/dossier/api";
import { readSourceTicket } from "../src/dossier/sources";
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
  it("saves original request permissions and rejects client authority", async () => {
    const input = { dossierId: "CO1.REQ.1", message: "Guarda un plan", expectedRevision: 0, idempotencyKey: "expert-authority-test" };
    const admitted: any = await executePrivateOperation(env, context, "chat", input, "https://test.invalid");
    const saved = await repo.read<any>("message", "chat.expert-authority-test");
    await repo.cancelJob(admitted.job.id);
    expect(saved.value.authority.scopes).toEqual(["conversation:write", "dossier:read"]);
    expect(saved.value.authority.requestHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(executePrivateOperation(env, context, "chat", { ...input, authority: { scopes: ["dossier:write"] } }, "https://test.invalid")).rejects.toThrow();
    await expect(executePrivateOperation(env, { ...context, scopes: [...context.scopes, "dossier:write"] }, "chat", input, "https://test.invalid")).rejects.toMatchObject({code: "IDEMPOTENCY_CONFLICT"});
  });

  it("loads the same persisted conversation with human source labels and OCR coverage", async () => {
    const r = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: { method: "load" },
    });
    expect(r.conversationId).toBe("conversation");
    expect(r.documentActions).toEqual([]);
    expect(r.messages.map((x: any) => x.role)).toEqual(["user", "assistant"]);
    expect(r.messages[1].citations[0]).toMatchObject({
      label: "Estudios previos · pág. 3",
      excerpt: "mínimo dos (2) certificaciones",
    });
    expect(r.messages[1].citations[0]).not.toHaveProperty("canOpen");
    expect(r.coverage.complete).toBe(false);
    expect(r.coverage.label).toContain("1 extracción");
    expect(r.messages[1].text).toContain(
      "1 extracción requiere revisión contra el original",
    );
    expect(r.messages[1].insufficientEvidence).toBe(true);
  });
  it("marks only stored dossier PDFs as openable and returns a page-specific source ticket", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\noriginal tender");
    await repo.putFile("doc", pdf, "application/pdf");
    const doc = await repo.read<any>("document", "doc");
    await repo.save(
      "document",
      "doc",
      { ...doc.value, fileId: "doc" },
      doc.revision,
    );
    const loaded = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: { method: "load" },
    });
    expect(loaded.messages[1].citations[0].canOpen).toBe(true);
    const unrelatedTurns = Array.from(
      { length: 30 },
      (_, index) => `unrelated-turn-${index}`,
    );
    for (const turnId of unrelatedTurns)
      await repo.save(
        "message",
        turnId,
        {
          userMessage: "Unrelated history",
          answer: "Not needed to open one source.",
          citations: [],
        },
        0,
      );
    const conversation = await repo.read<any>("conversation", "conversation");
    await repo.save(
      "conversation",
      "conversation",
      {
        ...conversation.value,
        turnIds: [...conversation.value.turnIds, ...unrelatedTurns],
      },
      conversation.revision,
    );
    const openSourceHead = vi.spyOn(DossierRepository.prototype, "headFile");
    const opened = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: {
        method: "open-source",
        messageId: "turn",
        citationId: "S001",
      },
    });
    expect(opened.messages).toEqual([]);
    expect(openSourceHead).toHaveBeenCalledTimes(1);
    openSourceHead.mockRestore();
    expect(opened.source.url).toMatch(
      /^https:\/\/test\.invalid\/private\/source\//,
    );
    expect(opened.source.url).toMatch(/\/view#page=3$/);
    const token = new URL(opened.source.url).pathname.split("/").at(-2)!;
    const response = await privateApiRequest(
      new Request(`https://test.invalid/private/source/${token}`),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/attachment/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdf);
    await expect(
      readSourceTicket(env, `${token.slice(0, -1)}x`),
    ).rejects.toMatchObject({
      code: "SOURCE_TICKET_INVALID",
    });
    await expect(
      readSourceTicket(env, token, Number.MAX_SAFE_INTEGER),
    ).rejects.toMatchObject({
      code: "SOURCE_TICKET_INVALID",
    });
    const viewer = await privateApiRequest(
      new Request(`https://test.invalid/private/source/${token}/view#page=3`),
      env,
    );
    const html = await viewer.text();
    expect(viewer.status).toBe(200);
    expect(viewer.headers.get("content-type")).toContain("text/html");
    expect(viewer.headers.get("cache-control")).toBe("no-store");
    expect(viewer.headers.get("referrer-policy")).toBe("no-referrer");
    expect(viewer.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(viewer.headers.get("content-security-policy")).toContain(
      "'wasm-unsafe-eval'",
    );
    expect(html).toContain("Página anterior");
    expect(html).toContain("Descargar original");
    expect(html).toContain(">Reintentar</button>");
    expect(html).toContain("La cita apunta a la página");
    expect(html).toContain("Math.min(2,window.devicePixelRatio||1)");
    expect(html).toContain("generation!==renderGeneration");
    expect(html).toContain("previous.cancel();try{await previous.promise");
    expect(html).toContain("n>pdf.numPages");
    expect(html).toContain("/private/source-assets/pdfjs-6.4.299/pdf.mjs");
    expect(html).not.toContain("https://cdn");
    const sourceId = token.split(".")[1];
    const sourceTicket = await repo.read<any>("source", sourceId);
    await repo.save(
      "source",
      sourceId,
      { ...sourceTicket.value, expiresAt: 0 },
      sourceTicket.revision,
    );
    const expiredViewer = await privateApiRequest(
      new Request(`https://test.invalid/private/source/${token}/view`),
      env,
    );
    expect(expiredViewer.status).toBe(404);
  });
  it("serves only fixed self-hosted PDF.js assets with immutable cache headers", async () => {
    for (const path of [
      "pdf.mjs",
      "pdf.worker.mjs",
      "wasm/openjpeg.wasm",
      "standard_fonts/LiberationSans-Regular.ttf",
      "cmaps/UniJIS-UCS2-H.bcmap",
    ]) {
      const response = await privateApiRequest(
        new Request(
          `https://test.invalid/private/source-assets/pdfjs-6.4.299/${path}`,
        ),
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-type")).toBeTruthy();
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    const traversal = await privateApiRequest(
      new Request(
        "https://test.invalid/private/source-assets/pdfjs-6.4.299/cmaps/%2e%2e%2fpackage.json",
      ),
      env,
    );
    expect(traversal.status).toBe(404);
    for (const inheritedPath of [
      "constructor",
      "__proto__",
      "cmaps/__proto__.bcmap",
      "cmaps/toString.bcmap",
    ]) {
      const response = await privateApiRequest(
        new Request(
          `https://test.invalid/private/source-assets/pdfjs-6.4.299/${inheritedPath}`,
        ),
        env,
      );
      expect(response.status).toBe(404);
    }
  });
  it("rejects unknown citations and prevents ticket use by another owner", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\noriginal tender");
    await repo.putFile("doc", pdf, "application/pdf");
    const doc = await repo.read<any>("document", "doc");
    await repo.save(
      "document",
      "doc",
      { ...doc.value, fileId: "doc" },
      doc.revision,
    );
    await expect(
      call({
        context: { dossierId: "CO1.REQ.1" },
        request: {
          method: "open-source",
          messageId: "turn",
          citationId: "S002",
        },
      }),
    ).rejects.toMatchObject({ status: 404 });
    const opened = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: { method: "open-source", messageId: "turn", citationId: "S001" },
    });
    const otherRepo = new DossierRepository(env, {
      ...context,
      ownerId: "source-test-owner",
    });
    await otherRepo.save("dossier", "CO1.REQ.1", { corpusRevision: 6 }, 0);
    await otherRepo.save("document", "doc", { ...doc.value, fileId: "doc" }, 0);
    await otherRepo.save(
      "conversation",
      "conversation",
      {
        dossierId: "CO1.REQ.1",
        title: "Test",
        turnIds: ["turn"],
      },
      0,
    );
    await otherRepo.save(
      "message",
      "turn",
      {
        userMessage: "Requisitos",
        answer: "Mínimo dos certificaciones.",
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
    await expect(
      executePrivateOperation(
        env,
        { ...context, ownerId: "source-test-owner" },
        "assistant" as any,
        {
          context: { dossierId: "CO1.REQ.1" },
          request: {
            method: "open-source",
            messageId: "turn",
            citationId: "S001",
          },
        },
        "https://test.invalid",
      ),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_AVAILABLE" });
    await otherRepo.save("dossier", "CO1.REQ.2", { corpusRevision: 1 }, 0);
    await expect(
      call({
        context: { dossierId: "CO1.REQ.2" },
        request: {
          method: "open-source",
          messageId: "turn",
          citationId: "S001",
        },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("maps checklist requirements to bounded source-linked task suggestions", async () => {
    await repo.save(
      "conversation",
      "checklist-conversation",
      {
        dossierId: "CO1.REQ.1",
        title: "Checklist",
        turnIds: ["checklist-turn"],
      },
      0,
    );
    await repo.save(
      "message",
      "checklist-turn",
      {
        userMessage: "Todos los requisitos",
        answer: "",
        citations: [],
        checklist: {
          dossierId: "CO1.REQ.1",
          corpusRevision: 6,
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
              requirementId: "req-1",
              reference: "R001",
              wording: "A".repeat(250),
              category: "documents",
              citations: [{ sourceRef: "S001" }],
            },
            {
              requirementId: "req-2",
              reference: "R002",
              wording: "Presentar garantía",
              category: "guarantees",
              citations: [{ sourceRef: "S002" }],
            },
          ],
          sources: [
            {
              reference: "S001",
              documentVersionId: "doc",
              page: 3,
              excerpt: "evidence one",
            },
            {
              reference: "S002",
              documentVersionId: "doc",
              page: 4,
              excerpt: "evidence two",
            },
          ],
          evidenceGaps: [],
          companyEvidence: { profileAttached: false, documents: [], note: "" },
          cautions: [],
        },
        corpusRevision: 6,
      },
      0,
    );
    const result = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: { method: "load" },
    });
    const suggestions = result.messages.find(
      (message: any) => message.id === "checklist-turn",
    ).taskSuggestions;
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].id).toBe("req-1");
    expect(suggestions[0].title).toHaveLength(200);
    expect(suggestions[0].description).toContain("R001");
    expect(suggestions[0].citationIds).toEqual(["S001"]);
    expect(suggestions[1].id).toBe("req-2");
    expect(suggestions[1].citationIds).toEqual(["S002"]);
  });
  it("checks stored PDF metadata once per distinct source across transcript history", async () => {
    const cacheRepo = new DossierRepository(env, {
      ownerId: "source-cache-owner",
      scopes: ["dossier:read"],
    });
    const pdf = new TextEncoder().encode("%PDF-1.7\nsource");
    await cacheRepo.save("dossier", "CO1.REQ.9", { corpusRevision: 1 }, 0);
    await cacheRepo.putFile("cached-doc", pdf, "application/pdf");
    await cacheRepo.save(
      "document",
      "cached-doc",
      {
        name: "Source",
        dossierId: "CO1.REQ.9",
        fileId: "cached-doc",
        state: "ready",
      },
      0,
    );
    const turnIds = Array.from(
      { length: 20 },
      (_, index) => `cached-turn-${index}`,
    );
    for (const turnId of turnIds)
      await cacheRepo.save(
        "message",
        turnId,
        {
          userMessage: "Question",
          answer: "Answer",
          citations: [
            { documentVersionId: "cached-doc", page: 1, excerpt: "evidence" },
          ],
        },
        0,
      );
    await cacheRepo.save(
      "conversation",
      "source-cache-conversation",
      {
        dossierId: "CO1.REQ.9",
        title: "Cache test",
        turnIds,
      },
      0,
    );
    const head = vi.spyOn(DossierRepository.prototype, "headFile");
    const result: any = await executePrivateOperation(
      env,
      {
        ownerId: "source-cache-owner",
        scopes: ["dossier:read"],
      },
      "assistant" as any,
      {
        context: { dossierId: "CO1.REQ.9" },
        request: { method: "load" },
      },
      "https://test.invalid",
    );
    expect(result.messages).toHaveLength(40);
    expect(result.messages[1].citations[0].canOpen).toBe(true);
    expect(head).toHaveBeenCalledTimes(1);
    head.mockRestore();
  });
  it("returns all pages of the selected conversation for complete transcript copying", async () => {
    const turnIds = Array.from({ length: 23 }, (_, i) => `history-${i}`);
    for (const [i, turnId] of turnIds.entries())
      await repo.save(
        "message",
        turnId,
        {
          userMessage: `Question ${i}`,
          answer: `Answer ${i}`,
          citations: [],
          corpusRevision: 6,
          companyRevision: null,
        },
        0,
      );
    const current = await repo.read<any>("conversation", "conversation");
    await repo.save(
      "conversation",
      "conversation",
      { ...current.value, turnIds },
      current.revision,
    );
    const result = await call({
      context: { dossierId: "CO1.REQ.1" },
      request: { method: "load" },
    });
    expect(result.messages).toHaveLength(46);
    expect(result.messages[0].text).toBe("Question 0");
    expect(result.messages.at(-1).text).toMatch(
      /^Answer 22\n\n1 extracción requiere revisión/,
    );
    const changed = await repo.read<any>("conversation", "conversation");
    await repo.save(
      "conversation",
      "conversation",
      { ...changed.value, turnIds: ["turn"] },
      changed.revision,
    );
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
