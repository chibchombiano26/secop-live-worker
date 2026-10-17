import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unzipSync } from "fflate";
import { readFileSync, writeFileSync } from "node:fs";
import { DossierRepository } from "../src/dossier/repository";
import { executePrivateOperation, privateApiRequest } from "../src/dossier/api";
import { createProposalDocument } from "../src/dossier/proposal";
import { sweepExpiredProposals } from "../src/dossier/retention";

// Decode each entity once: literal entity text must survive the test extraction.
function decodeXmlText(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
  };
  return text.replace(/&(?:amp|lt|gt);/gu, (entity) => entities[entity]);
}

let mf: Miniflare;
let env: any;
let repo: DossierRepository;
const context: any = { ownerId: "proposal-owner", scopes: ["dossier:read"] };
const dossierId = "CO1.REQ.987654321";
const sourceText =
  "El proponente deberá acreditar experiencia mínima en servicios de soporte & operación <según pliego>. Campo OCR\u0001 revisable. Literal &lt;texto&gt;.";

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
    dossierId,
    {
      processId: dossierId,
      corpusRevision: 4,
      reportId: `${dossierId}:4`,
      needsSynthesis: false,
      coverage: { inventoryComplete: true, total: 1 },
      descriptionId: `description:${dossierId}:4`,
      description: {
        objeto: "Servicios de soporte para la entidad",
        budget: "COP 900.000.000",
      },
      documentIds: ["tender-source"],
    },
    0,
  );
  await repo.save(
    "document",
    "tender-source",
    { dossierId, name: "Pliego definitivo", state: "ready" },
    0,
  );
  await repo.save(
    "chunk",
    "tender-source.0",
    {
      documentVersionId: "tender-source",
      page: 8,
      section: "Experiencia",
      index: 0,
      text: sourceText,
    },
    0,
  );
  await repo.save(
    "document",
    `description:${dossierId}:4`,
    { dossierId, name: "Descripción oficial", state: "ready" },
    0,
  );
  await repo.save(
    "chunk",
    `description:${dossierId}:4.0`,
    {
      documentVersionId: `description:${dossierId}:4`,
      section: "Official process description",
      index: 0,
      text: "objeto: Servicios de soporte para la entidad\nbudget: COP 900.000.000",
    },
    0,
  );
  await repo.save(
    "chunk",
    `description:${dossierId}:4.1`,
    {
      documentVersionId: `description:${dossierId}:4`,
      section: "Additional official fields",
      index: 1,
      text: "Condición adicional de la ficha: acudir a la audiencia de aclaraciones del proceso.",
    },
    0,
  );
  const requirementId = "requirement-current";
  await repo.save(
    "requirement",
    requirementId,
    {
      dossierId,
      corpusRevision: 4,
      wording:
        "Acreditar experiencia mínima en servicios de soporte & operación <según pliego>.",
      category: "experience",
      mandatory: true,
      lot: null,
      deadline: "2025-01-01",
      rule: null,
      citations: [
        {
          documentVersionId: "tender-source",
          page: 8,
          section: "Experiencia",
          excerpt: sourceText,
        },
      ],
    },
    0,
  );
  await repo.save(
    "report",
    `${dossierId}:4`,
    {
      dossierId,
      corpusRevision: 4,
      requirementIds: [requirementId],
      coverage: { total: 1, indexed: 1, pending: [], reviewRequired: [] },
      conflicts: [],
    },
    0,
  );
  await repo.save(
    "company",
    "selected-company",
    {
      name: "Servicios Andinos S.A.S. & Asociados",
      legalId: "900123456-7",
      activities: "Mantenimiento y soporte de infraestructura",
      facts: [],
    },
    0,
  );
  await repo.save(
    "document",
    "company-evidence-doc",
    {
      dossierId: "company:selected-company",
      name: "Certificado vencido",
      state: "ready",
      expiresOn: "2020-01-01",
    },
    0,
  );
  await repo.save(
    "evidence",
    "company-evidence-link",
    {
      companyId: "selected-company",
      documentId: "company-evidence-doc",
      expiresOn: "2020-01-01",
    },
    0,
  );
});
afterAll(async () => mf.dispose());

describe("SECOP proposal DOCX", () => {
  it("generates a real editable OOXML draft with full requirements, citations, and cautious company facts", async () => {
    const loaded = (await executePrivateOperation(
      env,
      context,
      "assistant",
      {
        context: { dossierId, companyProfileId: "selected-company" },
        request: { method: "load" },
      },
      "https://test.invalid",
    )) as any;
    expect(loaded.documentActions).toEqual([
      { id: "proposal-docx", label: "Generar propuesta DOCX", format: "docx" },
    ]);
    const result = (await executePrivateOperation(
      env,
      context,
      "assistant",
      {
        context: { dossierId, companyProfileId: "selected-company" },
        request: { method: "generate-document", actionId: "proposal-docx" },
      },
      "https://test.invalid",
    )) as any;
    expect(result).toMatchObject({
      revision: 0,
      messages: [],
      document: { fileName: "borrador-propuesta.docx", format: "docx" },
    });
    expect(result.document.url).toMatch(
      /^https:\/\/test.invalid\/private\/proposal\//,
    );
    const response = await privateApiRequest(
      new Request(result.document.url),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const docxBytes = new Uint8Array(await response.arrayBuffer());
    if (process.env.SECOP_PROPOSAL_FIXTURE_OUTPUT)
      writeFileSync(process.env.SECOP_PROPOSAL_FIXTURE_OUTPUT, docxBytes);
    const parts = unzipSync(docxBytes);
    expect(Object.keys(parts)).toContain("word/document.xml");
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;según pliego&gt;");
    expect(xml).not.toContain("\u0001");
    expect(xml).not.toContain("<w:br/>");
    expect(xml).not.toContain("<w:keepLines/>");
    const paragraphTexts = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/gu)].map(
      ([paragraph]) =>
        decodeXmlText(paragraph.replace(/<[^>]+>/gu, " "))
          .replace(/\s+/gu, " ")
          .trim(),
    );
    expect(paragraphTexts).toContain(
      "R001 · Experiencia · marcado obligatorio",
    );
    expect(paragraphTexts).toContain(
      "Acreditar experiencia mínima en servicios de soporte & operación <según pliego>.",
    );
    const styles = new TextDecoder().decode(parts["word/styles.xml"]);
    expect(styles).toContain('w:styleId="Requirement"');
    expect(styles).toContain('w:styleId="SourceTitle"');
    expect(styles).toContain('w:styleId="SourceText"');
    const text = decodeXmlText(xml.replace(/<[^>]+>/gu, " "));
    expect(text).toContain("Literal &lt;texto&gt;.");
    expect(text).toContain("Servicios Andinos S.A.S. & Asociados");
    expect(text).toContain("900123456-7");
    expect(text).toContain("R001");
    expect(text).toContain("Pliego definitivo · pág. 8");
    expect(text).toContain("VENCIDA");
    expect(text).toContain("COP 900.000.000");
    expect(text).not.toContain("COP 900.000.000 COP");
    expect(text).toContain("D001");
    expect(text).toContain("D002");
    expect(text).toContain("acudir a la audiencia de aclaraciones del proceso");
    expect(text).toContain("revisión del expediente: 4");
    expect(text).toContain(
      "Este DOCX es un borrador editable y no ha sido presentado ni enviado a SECOP.",
    );
    expect(text).toContain("no certifica que la empresa cumpla");
    expect(text).not.toContain("la empresa cumple las condiciones");
  });

  it("rejects stale reports and selected-company changes before serving a prior ticket", async () => {
    await repo.save(
      "dossier",
      "stale-proposal",
      {
        corpusRevision: 2,
        reportId: "old",
        coverage: { inventoryComplete: true },
      },
      0,
    );
    await expect(
      createProposalDocument(
        repo,
        { dossierId: "stale-proposal", companyProfileId: "selected-company" },
        "https://test.invalid",
      ),
    ).rejects.toMatchObject({ code: "PROPOSAL_REPORT_NOT_READY" });

    const result = await createProposalDocument(
      repo,
      { dossierId, companyProfileId: "selected-company" },
      "https://test.invalid",
    );
    const profile = await repo.read<any>("company", "selected-company");
    await repo.save(
      "company",
      "selected-company",
      { ...profile.value, activities: "Changed after generation" },
      profile.revision,
    );
    const response = await privateApiRequest(
      new Request(result.document.url),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("creates an explicit editable proponent placeholder when no company profile is selected", async () => {
    const loaded = (await executePrivateOperation(
      env,
      context,
      "assistant",
      {
        context: { dossierId },
        request: { method: "load" },
      },
      "https://test.invalid",
    )) as any;
    expect(loaded.documentActions).toHaveLength(1);
    const result = (await executePrivateOperation(
      env,
      context,
      "assistant",
      {
        context: { dossierId },
        request: { method: "generate-document", actionId: "proposal-docx" },
      },
      "https://test.invalid",
    )) as any;
    const response = await privateApiRequest(
      new Request(result.document.url),
      env,
    );
    const parts = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const xml = new TextDecoder().decode(parts["word/document.xml"]);
    expect(xml).toContain("[COMPLETAR]");
    expect(xml).toContain("No se seleccionó un perfil de empresa");
    expect(xml).not.toContain("Servicios Andinos S.A.S.");
  });

  it("hides expired and other-owner tickets", async () => {
    const result = await createProposalDocument(
      repo,
      { dossierId, companyProfileId: "selected-company" },
      "https://test.invalid",
    );
    const token = new URL(result.document.url).pathname.split("/").at(-1)!;
    const foreign = await privateApiRequest(
      new Request(
        `https://test.invalid/private/proposal/${token.replace("proposal-owner", "other-owner")}`,
      ),
      env,
    );
    expect(foreign.status).toBe(404);
    const ticketId = token.split(".")[1];
    const ticket = await repo.read<any>("proposal", ticketId);
    await repo.save(
      "proposal",
      ticketId,
      { ...ticket.value, expiresAt: 0 },
      ticket.revision,
    );
    const expired = await privateApiRequest(
      new Request(result.document.url),
      env,
    );
    expect(expired.status).toBe(404);
    const ticketRow = await env.DOSSIER_DB.prepare(
      "SELECT id FROM dossier_records WHERE owner_id=? AND kind='proposal' AND id=?",
    )
      .bind(context.ownerId, ticketId)
      .first();
    expect(ticketRow).toBeTruthy();
    await sweepExpiredProposals(env, repo.now());
    await expect(repo.read("proposal", ticketId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await repo.headFile(ticket.value.fileId)).toBeNull();
  });
});
