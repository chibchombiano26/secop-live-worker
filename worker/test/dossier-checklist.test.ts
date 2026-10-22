import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import {
  buildExhaustiveChecklist,
  checklistDeadlineStatus,
  renderExhaustiveChecklist,
  type ExhaustiveChecklist,
} from "../src/dossier/checklist";
import { DossierRepository } from "../src/dossier/repository";

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
    checklist.items[0] = {
      ...checklist.items[0],
      wording: "Presentación de ofertas",
      deadline: "30 de abril de 2026",
      deadlineStatus: "past",
    };
    const compact = renderExhaustiveChecklist(checklist, {
      includeSourceExcerpts: false,
    });
    expect(compact).toMatch(/^## Plazo de presentación transcurrido/);
    expect(compact).toContain("[S001] Pliego.pdf (p. 10)");
    expect(compact).toContain(
      "No se debe asumir que este proceso recibe ofertas",
    );
    for (const wording of [
      "Presentación de observaciones al pliego hasta el 14 de octubre",
      "Recepción de observaciones sobre las propuestas recibidas",
      "Entrega de respuestas a las observaciones a las ofertas",
    ]) {
      checklist.items[0].wording = wording;
      const observations = renderExhaustiveChecklist(checklist);
      expect(observations).not.toContain(
        "## Plazo de presentación transcurrido",
      );
      expect(observations).toContain(wording);
      expect(observations).toContain("30 de abril de 2026");
    }
    checklist.items[0].wording =
      "Fecha límite para la recepción de las propuestas";
    expect(renderExhaustiveChecklist(checklist)).toMatch(
      /^## Plazo de presentación transcurrido/,
    );
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

describe("exhaustive checklist repository loading", () => {
  let mf: Miniflare;
  let env: any;
  let repo: DossierRepository;
  const context = {
    ownerId: "checklist-load-owner",
    scopes: ["dossier:read"] as (
      "dossier:read" | "dossier:write" | "company:write" | "conversation:write"
    )[],
  };
  const dossierId = "CO1.REQ.445566";
  const reportId = `${dossierId}:7`;
  const documentIds = Array.from({ length: 11 }, (_, index) => `doc-${index}`);
  const requirementIds = Array.from(
    { length: 213 },
    (_, index) => `requirement-${index}`,
  );
  const sourceText = "The bidder must provide the requested evidence.";

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
    const statements: D1PreparedStatement[] = [];
    const addRecord = (kind: string, id: string, value: unknown) =>
      statements.push(
        env.DOSSIER_DB.prepare(
          "INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) VALUES(?,?,?,1,?,?)",
        ).bind(context.ownerId, kind, id, JSON.stringify(value), Date.now()),
      );
    addRecord("dossier", dossierId, {
      corpusRevision: 7,
      documentIds,
      descriptionId: "description-official",
      coverage: { inventoryComplete: true },
    });
    for (const id of [...documentIds, "description-official"])
      addRecord("document", id, { name: id, state: "ready" });
    for (const id of requirementIds)
      addRecord("requirement", id, {
        dossierId,
        corpusRevision: 7,
        wording: `Condition in ${id}: ${"supporting evidence ".repeat(80)}`,
        category: "experience",
        mandatory: true,
        lot: null,
        deadline: null,
        rule: null,
        citations: [
          {
            documentVersionId: documentIds[0],
            page: 1,
            excerpt: sourceText,
          },
        ],
      });
    for (let offset = 0; offset < statements.length; offset += 80)
      await env.DOSSIER_DB.batch(statements.slice(offset, offset + 80));
  });
  afterAll(async () => mf?.dispose());

  function countedRepository() {
    const queries: string[] = [];
    const db = new Proxy(env.DOSSIER_DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "prepare")
          return (...args: Parameters<D1Database["prepare"]>) => {
            queries.push(String(args[0]));
            return value.apply(target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return {
      repo: new DossierRepository({ ...env, DOSSIER_DB: db }, context),
      queries: () => queries,
    };
  }

  it("loads 213 requirements and the complete document inventory in bounded scoped queries", async () => {
    const counted = countedRepository();
    const chunk = {
      documentVersionId: documentIds[0],
      page: 1,
      index: 0,
      text: sourceText,
    };
    const checklist = await buildExhaustiveChecklist(
      counted.repo,
      dossierId,
      7,
      reportId,
      { dossierId, corpusRevision: 7, requirementIds },
      [chunk],
      null,
    );

    expect(
      JSON.stringify(checklist).length +
        renderExhaustiveChecklist(checklist).length * 2,
    ).toBeGreaterThan(500_000);
    expect(checklist.items).toHaveLength(213);
    expect(checklist.items[0].requirementId).toBe(requirementIds[0]);
    expect(checklist.items.at(-1)?.requirementId).toBe(requirementIds.at(-1));
    expect(checklist.coverage.listedDocuments).toBe(12);
    expect(checklist.sources[0].reference).toBe("S001");
    expect(
      counted.queries().filter((sql) => sql.includes("id IN (")).length,
    ).toBe(6);
    expect(counted.queries()).toHaveLength(7);
  });

  it("rejects duplicate report IDs before reading any database rows", async () => {
    const counted = countedRepository();
    await expect(
      buildExhaustiveChecklist(
        counted.repo,
        dossierId,
        7,
        reportId,
        {
          dossierId,
          corpusRevision: 7,
          requirementIds: [requirementIds[0], requirementIds[0]],
        },
        [
          {
            documentVersionId: documentIds[0],
            page: 1,
            index: 0,
            text: sourceText,
          },
        ],
        null,
      ),
    ).rejects.toMatchObject({ code: "CHECKLIST_INVALID_REPORT" });
    expect(counted.queries()).toHaveLength(0);
  });

  it("keeps optional description documents optional and rejects missing listed documents", async () => {
    const description = await repo.read("document", "description-official");
    await env.DOSSIER_DB.prepare(
      "DELETE FROM dossier_records WHERE owner_id=? AND kind='document' AND id=?",
    )
      .bind(context.ownerId, "description-official")
      .run();
    try {
      const checklist = await buildExhaustiveChecklist(
        repo,
        dossierId,
        7,
        reportId,
        { dossierId, corpusRevision: 7, requirementIds: [requirementIds[0]] },
        [
          {
            documentVersionId: documentIds[0],
            page: 1,
            index: 0,
            text: sourceText,
          },
        ],
        null,
      );
      expect(checklist.coverage.listedDocuments).toBe(11);
    } finally {
      await repo.save("document", description.id, description.value, 0);
    }

    await env.DOSSIER_DB.prepare(
      "DELETE FROM dossier_records WHERE owner_id=? AND kind='document' AND id=?",
    )
      .bind(context.ownerId, documentIds[10])
      .run();
    try {
      await expect(
        buildExhaustiveChecklist(
          repo,
          dossierId,
          7,
          reportId,
          { dossierId, corpusRevision: 7, requirementIds: [requirementIds[0]] },
          [
            {
              documentVersionId: documentIds[0],
              page: 1,
              index: 0,
              text: sourceText,
            },
          ],
          null,
        ),
      ).rejects.toMatchObject({ code: "CHECKLIST_STALE_SOURCE" });
    } finally {
      await repo.save(
        "document",
        documentIds[10],
        { name: documentIds[10], state: "ready" },
        0,
      );
    }
  });

  it("rejects requirements stored for another corpus revision", async () => {
    const stored = await repo.read<Record<string, unknown>>(
      "requirement",
      requirementIds[50],
    );
    await repo.save(
      "requirement",
      requirementIds[50],
      { ...stored.value, corpusRevision: 6 },
      stored.revision,
    );
    try {
      await expect(
        buildExhaustiveChecklist(
          repo,
          dossierId,
          7,
          reportId,
          { dossierId, corpusRevision: 7, requirementIds },
          [
            {
              documentVersionId: documentIds[0],
              page: 1,
              index: 0,
              text: sourceText,
            },
          ],
          null,
        ),
      ).rejects.toMatchObject({ code: "CHECKLIST_STALE_REQUIREMENT" });
    } finally {
      const current = await repo.read("requirement", requirementIds[50]);
      await repo.save(
        "requirement",
        requirementIds[50],
        stored.value,
        current.revision,
      );
    }
  });
});
