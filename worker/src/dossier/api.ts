import {
  assistantProviderSchema,
  runAssistantProvider,
} from "./assistant-provider";
import { consumeOwnerLimit } from "./limits";
import { z } from "zod/v4";
import {
  authenticatePrivateBearer,
  requirePrivateContext,
} from "./authorization";
import { DossierError, type PrivateContext } from "./contracts";
import { DossierRepository, type DossierEnv } from "./repository";
import {
  saveCompanyProfile,
  profileSchema,
  companyEvidence,
  reviewCompanyFact,
} from "./companies";
import { readAssessment, reviewFinding, findingSchema } from "./assessment";
import { readConversation, type ChatInput } from "./conversations";
import { createUploadTicket, acceptUploadTicket, uploadPage } from "./uploads";
import { boundedBytes } from "./downloads";
import type { DocumentVersion } from "./inventory";
import type { EvidenceChunk } from "./extraction";
import type { Env } from "../socrata";
const id = z.string().min(1).max(200);
const revision = z.number().int().min(0);
const key = z.string().min(8).max(100);
const page = {
  offset: z.coerce.number().int().min(0).max(50000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const routes = {
  assistant: {
    method: "POST",
    scope: "dossier:read",
    tool: "asistente_expediente",
    schema: assistantProviderSchema,
  },
  prepare: {
    method: "POST",
    scope: "dossier:write",
    tool: "preparar_expediente",
    schema: z
      .object({
        processId: z.string().regex(/^CO1\.REQ\.\d+$/),
        idempotencyKey: key,
      })
      .strict(),
  },
  dossier: {
    method: "GET",
    scope: "dossier:read",
    tool: "consultar_expediente",
    schema: z.object({ id, ...page }).strict(),
  },
  "review-document": {
    method: "POST",
    scope: "dossier:write",
    tool: "revisar_extraccion_documento",
    schema: z
      .object({
        documentId: id,
        expectedRevision: revision,
        note: z.string().min(3).max(2000),
      })
      .strict(),
  },
  retry: {
    method: "POST",
    scope: "dossier:write",
    tool: "reintentar_documento",
    schema: z
      .object({ jobId: id.optional(), documentId: id.optional() })
      .strict(),
  },
  companies: {
    method: "GET",
    scope: "dossier:read",
    tool: "listar_empresas",
    schema: z.object(page).strict(),
  },
  company: {
    method: "POST",
    scope: "company:write",
    tool: "guardar_perfil_empresa",
    schema: z
      .object({
        id: id.optional(),
        expectedRevision: revision,
        profile: profileSchema,
      })
      .strict(),
  },
  "company-detail": {
    method: "GET",
    scope: "dossier:read",
    tool: "consultar_perfil_empresa",
    schema: z.object({ id }).strict(),
  },
  "company-fact-review": {
    method: "POST",
    scope: "company:write",
    tool: "revisar_dato_empresa",
    schema: z
      .object({
        companyId: id,
        index: z.number().int().min(0),
        note: z.string().min(3).max(2000),
        expectedRevision: revision,
      })
      .strict(),
  },
  "upload-ticket": {
    method: "POST",
    scope: "dossier:write",
    tool: "registrar_documento_expediente",
    schema: z
      .object({
        documentId: id.optional(),
        companyId: id.optional(),
        expiresOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .strict(),
  },
  assess: {
    method: "POST",
    scope: "company:write",
    tool: "evaluar_empresa",
    schema: z
      .object({
        dossierId: id,
        companyId: id,
        corpusRevision: revision,
        companyRevision: revision,
        selectedLots: z.array(z.string().max(200)).max(100).default([]),
        idempotencyKey: key,
      })
      .strict(),
  },
  assessment: {
    method: "GET",
    scope: "dossier:read",
    tool: "consultar_evaluacion",
    schema: z
      .object({
        id: id.optional(),
        dossierId: id.optional(),
        companyId: id.optional(),
      })
      .strict(),
  },
  "review-finding": {
    method: "POST",
    scope: "company:write",
    tool: "revisar_requisito",
    schema: z
      .object({
        assessmentId: id,
        requirementId: id,
        decision: findingSchema.shape.status,
        note: z.string().min(3).max(2000),
        expectedRevision: revision,
      })
      .strict(),
  },
  chat: {
    method: "POST",
    scope: "conversation:write",
    tool: "conversar_licitacion",
    schema: z
      .object({
        dossierId: id,
        companyProfileId: id.optional(),
        conversationId: id.optional(),
        expectedRevision: revision,
        message: z.string().trim().min(1).max(8000),
        idempotencyKey: key,
      })
      .strict(),
  },
  conversation: {
    method: "GET",
    scope: "dossier:read",
    tool: "consultar_conversacion",
    schema: z
      .object({
        id: id.optional(),
        dossierId: id.optional(),
        companyProfileId: id.optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .strict(),
  },
  job: {
    method: "GET",
    scope: "dossier:read",
    tool: "consultar_trabajo",
    schema: z.object({ id }).strict(),
  },
  cancel: {
    method: "POST",
    scope: "dossier:write",
    tool: "cancelar_trabajo",
    schema: z.object({ id }).strict(),
  },
  citation: {
    method: "GET",
    scope: "dossier:read",
    tool: "consultar_evidencia",
    schema: z
      .object({
        documentId: id,
        page: z.coerce.number().int().positive().optional(),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .strict(),
  },
  tasks: {
    method: "GET",
    scope: "dossier:read",
    tool: "consultar_pendientes",
    schema: z.object({ assessmentId: id }).strict(),
  },
  "update-task": {
    method: "POST",
    scope: "company:write",
    tool: "actualizar_pendiente",
    schema: z
      .object({
        id,
        expectedRevision: revision,
        owner: z.string().max(200).nullable(),
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        state: z.enum(["pending", "in_progress", "done"]),
      })
      .strict(),
  },
  "delete-document": {
    method: "POST",
    scope: "company:write",
    tool: "eliminar_evidencia_empresa",
    schema: z
      .object({
        documentId: id,
        expectedRevision: revision,
        confirmed: z.literal(true),
      })
      .strict(),
  },
} as const;
export const routeContract = routes;
export type PrivateServiceEnv = Env & DossierEnv;
type Route = keyof typeof routes;
export async function executePrivateOperation(
  env: PrivateServiceEnv,
  context: PrivateContext,
  name: Route,
  raw: unknown,
  origin: string,
) {
  const route = routes[name];
  requirePrivateContext(context, route.scope);
  const input = route.schema.parse(raw);
  const repo = new DossierRepository(env, context);
  const readRequest = route.method === "GET" || name === "assistant";
  await consumeOwnerLimit(
    repo,
    readRequest ? "read" : "write",
    readRequest ? 240 : 30,
    60000,
  );
  // Every branch parses the same shared schema again for a precise discriminated type.
  switch (name) {
    case "assistant":
      return runAssistantProvider(
        repo,
        assistantProviderSchema.parse(input),
        (args): Promise<unknown> =>
          executePrivateOperation(env, context, "chat", args, origin),
      );
    case "prepare": {
      const a = routes.prepare.schema.parse(input);
      const dossier = await repo.createOrGetDossier(a.processId);
      const job = await repo.enqueueJob({
        kind: "inventory",
        targetId: dossier.id,
        key: `inventory:${dossier.id}:${a.idempotencyKey}`,
      });
      return { dossier, job };
    }
    case "dossier": {
      const a = routes.dossier.schema.parse(input);
      let dossier;
      try {
        dossier = await repo.readDossier(a.id);
      } catch (e) {
        if (e instanceof DossierError && e.code === "NOT_FOUND")
          return {
            dossier: null,
            documents: [],
            documentTotal: 0,
            report: null,
            requirements: [],
            jobs: [],
            nextOffset: null,
          };
        throw e;
      }
      const ids = (dossier.value.documentIds ?? []) as string[];
      const documents = await Promise.all(
        ids
          .slice(a.offset, a.offset + a.limit)
          .map((id) => repo.read("document", id)),
      );
      let report: unknown = null;
      let requirements: unknown[] = [];
      if (dossier.value.reportId) {
        const stored = await repo.read<{ requirementIds: string[] }>(
          "report",
          String(dossier.value.reportId),
        );
        report = stored;
        requirements = await Promise.all(
          stored.value.requirementIds
            .slice(a.offset, a.offset + a.limit)
            .map((id) => repo.read("requirement", id)),
        );
      }
      const jobs = await repo.db
        .prepare(
          "SELECT j.id,j.kind,j.target_id AS targetId,j.state,j.error,j.progress,j.created_at AS createdAt FROM dossier_jobs j WHERE j.owner_id=? AND (j.target_id=? OR j.target_id IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM dossier_records r WHERE r.owner_id=j.owner_id AND r.id=j.target_id AND r.kind IN ('task','message') AND json_extract(r.value,'$.dossierId')=?)) ORDER BY j.created_at DESC LIMIT 50",
        )
        .bind(context.ownerId, a.id, JSON.stringify(ids), a.id)
        .all();
      const counts = await repo.db
        .prepare(
          "SELECT json_extract(value,'$.state') AS state,count(*) AS total FROM dossier_records WHERE owner_id=? AND kind='document' AND id IN (SELECT value FROM json_each(?)) GROUP BY state",
        )
        .bind(context.ownerId, JSON.stringify(ids))
        .all<{ state: string; total: number }>();
      return {
        dossier,
        documents,
        documentTotal: ids.length,
        report,
        requirements,
        jobs: jobs.results.map((j) => ({
          ...j,
          progress: JSON.parse(String(j.progress)),
        })),
        coverageCounts: Object.fromEntries(
          counts.results.map((c) => [c.state, c.total]),
        ),
        nextOffset:
          a.offset + a.limit <
          Math.max(
            ids.length,
            (report as { value?: { requirementIds?: string[] } } | null)?.value
              ?.requirementIds?.length ?? 0,
          )
            ? a.offset + a.limit
            : null,
      };
    }
    case "review-document": {
      const a = routes["review-document"].schema.parse(input);
      const doc = await repo.read<DocumentVersion>("document", a.documentId);
      if (doc.value.dossierId.startsWith("company:"))
        requirePrivateContext(context, "company:write");
      if (doc.value.state !== "review_required")
        throw new DossierError("DOCUMENT_NOT_REVIEWABLE", 409);
      const updated = await repo.save(
        "document",
        doc.id,
        {
          ...doc.value,
          state: "ready",
          reviewNote: a.note,
          reviewedAt: repo.now(),
        },
        a.expectedRevision,
      );
      await repo.save(
        "review",
        crypto.randomUUID(),
        {
          kind: "document_extraction",
          documentId: doc.id,
          note: a.note,
          at: repo.now(),
          actor: "authorized_connection",
        },
        0,
      );
      if (!doc.value.dossierId.startsWith("company:")) {
        const dossier = await repo.readDossier(doc.value.dossierId);
        await repo.save(
          "dossier",
          dossier.id,
          { ...dossier.value, needsSynthesis: true },
          dossier.revision,
        );
        await repo.enqueueJob({
          kind: "synthesize",
          targetId: dossier.id,
          key: `review-synthesis:${dossier.id}:${crypto.randomUUID()}`,
        });
      } else {
        const companyId = doc.value.dossierId.slice(8);
        const company = await repo.read<Record<string, unknown>>(
          "company",
          companyId,
        );
        await repo.save(
          "company",
          companyId,
          { ...company.value, evidenceChangedAt: repo.now() },
          company.revision,
        );
      }
      return updated;
    }
    case "retry": {
      const a = routes.retry.schema.parse(input);
      if (a.jobId) {
        const job = await repo.readJob(a.jobId);
        if (!["failed", "cancelled"].includes(job.state))
          throw new DossierError("JOB_NOT_RETRYABLE", 409);
        await repo.db
          .prepare(
            "UPDATE dossier_jobs SET state='queued',attempts=0,available_at=?,dispatched_at=NULL,error=NULL WHERE owner_id=? AND id=? AND state IN ('failed','cancelled')",
          )
          .bind(repo.now(), context.ownerId, a.jobId)
          .run();
        return repo.readJob(a.jobId);
      }
      if (a.documentId) {
        const doc = await repo.read<DocumentVersion>("document", a.documentId);
        if (!["blocked", "failed", "pending"].includes(doc.value.state))
          throw new DossierError("DOCUMENT_NOT_RETRYABLE", 409);
        const job = await repo.enqueueJob({
          kind: "extract",
          targetId: doc.id,
          key: `extract-retry:${doc.id}:${crypto.randomUUID()}`,
        });
        return { job };
      }
      throw new DossierError("RETRY_TARGET_REQUIRED");
    }
    case "companies": {
      const a = routes.companies.schema.parse(input);
      return { companies: await repo.list("company", a.offset, a.limit) };
    }
    case "company": {
      const a = routes.company.schema.parse(input);
      return saveCompanyProfile(repo, a.profile, a.expectedRevision, a.id);
    }
    case "company-detail": {
      const a = routes["company-detail"].schema.parse(input);
      const data = await companyEvidence(repo, a.id);
      const jobs = await repo.db
        .prepare(
          "SELECT id,state,error,target_id AS targetId FROM dossier_jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT 100",
        )
        .bind(context.ownerId)
        .all<{ targetId: string }>();
      return {
        company: data.company,
        documents: data.docs,
        expiredDocumentIds: [...data.expired],
        jobs: jobs.results.filter(
          (j) =>
            j.targetId === a.id || data.docs.some((d) => d.id === j.targetId),
        ),
      };
    }
    case "company-fact-review": {
      const a = routes["company-fact-review"].schema.parse(input);
      return reviewCompanyFact(
        repo,
        a.companyId,
        a.index,
        a.note,
        a.expectedRevision,
      );
    }
    case "upload-ticket": {
      const a = routes["upload-ticket"].schema.parse(input);
      if (a.companyId) requirePrivateContext(context, "company:write");
      const ticket = await createUploadTicket(repo, a);
      return {
        url: `${origin}/private/upload#ticket=${encodeURIComponent(ticket.token)}`,
        expiresAt: ticket.expiresAt,
      };
    }
    case "assess": {
      const a = routes.assess.schema.parse(input);
      const currentDossier = await repo.readDossier(a.dossierId),
        currentCompany = await repo.read("company", a.companyId);
      if (
        currentDossier.value.corpusRevision !== a.corpusRevision ||
        currentCompany.revision !== a.companyRevision
      )
        throw new DossierError("ASSESSMENT_INPUT_CHANGED", 409);
      const requestId = `assess.${a.idempotencyKey}`;
      try {
        await repo.save(
          "task",
          requestId,
          { kind: "assessment_request", ...a },
          0,
        );
      } catch (e) {
        if (!(e instanceof DossierError) || e.code !== "REVISION_CONFLICT")
          throw e;
        const existing = await repo.read<{
          dossierId: string;
          companyId: string;
          selectedLots: string[];
          corpusRevision: number;
          companyRevision: number;
        }>("task", requestId);
        if (
          existing.value.dossierId !== a.dossierId ||
          existing.value.companyId !== a.companyId ||
          existing.value.corpusRevision !== a.corpusRevision ||
          existing.value.companyRevision !== a.companyRevision ||
          JSON.stringify(existing.value.selectedLots) !==
            JSON.stringify(a.selectedLots)
        )
          throw new DossierError("IDEMPOTENCY_CONFLICT", 409);
      }
      return {
        job: await repo.enqueueJob({
          kind: "assess",
          targetId: requestId,
          key: requestId,
        }),
      };
    }
    case "assessment": {
      const a = routes.assessment.schema.parse(input);
      if (a.id) return readAssessment(repo, a.id);
      if (!a.dossierId || !a.companyId)
        throw new DossierError("ASSESSMENT_TARGET_REQUIRED");
      await repo.readDossier(a.dossierId);
      await repo.read("company", a.companyId);
      const candidates = (
        await repo.all<{
          dossierId: string;
          companyId: string;
          generatedAt: number;
        }>("assessment")
      )
        .filter(
          (v) =>
            v.value.dossierId === a.dossierId &&
            v.value.companyId === a.companyId,
        )
        .sort((a, b) => b.value.generatedAt - a.value.generatedAt);
      return candidates.length ? readAssessment(repo, candidates[0].id) : null;
    }
    case "review-finding": {
      const a = routes["review-finding"].schema.parse(input);
      return reviewFinding(
        repo,
        a.assessmentId,
        a.requirementId,
        a.decision,
        a.note,
        a.expectedRevision,
      );
    }
    case "chat": {
      const a = routes.chat.schema.parse(input);
      await repo.readDossier(a.dossierId);
      if (a.companyProfileId) await repo.read("company", a.companyProfileId);
      if (a.conversationId) await repo.read("conversation", a.conversationId);
      const requestId = `chat.${a.idempotencyKey}`;
      try {
        await repo.save(
          "message",
          requestId,
          { kind: "chat_request", ...a },
          0,
        );
      } catch (e) {
        if (!(e instanceof DossierError) || e.code !== "REVISION_CONFLICT")
          throw e;
        const old = await repo.read<ChatInput>("message", requestId);
        if (
          JSON.stringify(old.value) !==
          JSON.stringify({ kind: "chat_request", ...a })
        )
          throw new DossierError("IDEMPOTENCY_CONFLICT", 409);
      }
      return {
        job: await repo.enqueueJob({
          kind: "chat",
          targetId: requestId,
          key: requestId,
        }),
      };
    }
    case "conversation": {
      const a = routes.conversation.schema.parse(input);
      if (a.id) return readConversation(repo, a.id, a.offset);
      if (!a.dossierId) throw new DossierError("DOSSIER_REQUIRED");
      await repo.readDossier(a.dossierId);
      const candidates = (
        await repo.all<{ dossierId: string; companyProfileId?: string }>(
          "conversation",
        )
      )
        .filter(
          (c) =>
            c.value.dossierId === a.dossierId &&
            c.value.companyProfileId === a.companyProfileId,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return candidates.length
        ? readConversation(repo, candidates[0].id, a.offset)
        : null;
    }
    case "job":
      return repo.readJob(routes.job.schema.parse(input).id);
    case "cancel": {
      const a = routes.cancel.schema.parse(input);
      await repo.cancelJob(a.id);
      return { cancelled: true };
    }
    case "citation": {
      const a = routes.citation.schema.parse(input);
      const doc = await repo.read<DocumentVersion>("document", a.documentId);
      if (doc.value.state === "deleted")
        throw new DossierError("EVIDENCE_DELETED", 410);
      const chunks = (
        await repo.allMatching<EvidenceChunk>("chunk", "documentVersionId", [
          a.documentId,
        ])
      ).filter((c) => a.page === undefined || c.value.page === a.page);
      return {
        document: doc,
        chunks: chunks.slice(a.offset, a.offset + 10),
        nextOffset: a.offset + 10 < chunks.length ? a.offset + 10 : null,
      };
    }
    case "tasks": {
      const a = routes.tasks.schema.parse(input);
      await repo.read("assessment", a.assessmentId);
      return {
        tasks: (await repo.all<{ assessmentId: string }>("task")).filter(
          (t) => t.value.assessmentId === a.assessmentId,
        ),
      };
    }
    case "update-task": {
      const a = routes["update-task"].schema.parse(input);
      const task = await repo.read<Record<string, unknown>>("task", a.id);
      if (!task.value.assessmentId) throw new DossierError("INVALID_TASK");
      return repo.save(
        "task",
        a.id,
        { ...task.value, owner: a.owner, dueDate: a.dueDate, state: a.state },
        a.expectedRevision,
      );
    }
    case "delete-document": {
      const a = routes["delete-document"].schema.parse(input);
      const doc = await repo.read<DocumentVersion>("document", a.documentId);
      if (!doc.value.dossierId.startsWith("company:"))
        throw new DossierError("COMPANY_EVIDENCE_REQUIRED", 403);
      await repo.save(
        "document",
        doc.id,
        { ...doc.value, state: "deleted", fileId: undefined },
        a.expectedRevision,
      );
      if (doc.value.fileId) await repo.deleteFile(doc.value.fileId);
      for (const c of await repo.allMatching<EvidenceChunk>(
        "chunk",
        "documentVersionId",
        [doc.id],
      ))
        await repo.save(
          "chunk",
          c.id,
          { ...c.value, text: "[Evidence deleted]" },
          c.revision,
        );
      const profileId = doc.value.dossierId.slice(8);
      const profile = await repo.read<Record<string, unknown>>(
        "company",
        profileId,
      );
      await repo.save(
        "company",
        profileId,
        { ...profile.value, evidenceChangedAt: repo.now() },
        profile.revision,
      );
      return { deleted: true };
    }
  }
}
export function privateOpenApi() {
  return {
    openapi: "3.1.0",
    info: { title: "SECOP private dossier service", version: "1.0.0" },
    components: {
      securitySchemes: { privateBearer: { type: "http", scheme: "bearer" } },
    },
    paths: Object.fromEntries(
      Object.entries(routes).map(([name, route]) => [
        `/private/v1/${name}`,
        {
          [route.method.toLowerCase()]: {
            operationId: route.tool,
            security: [{ privateBearer: [] }],
            ...(route.method === "POST"
              ? {
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": {
                        schema: z.toJSONSchema(route.schema),
                      },
                    },
                  },
                }
              : {
                  parameters: Object.entries(
                    z.toJSONSchema(route.schema).properties ?? {},
                  ).map(([name, schema]) => ({ name, in: "query", schema })),
                }),
            responses: {
              "200": { description: "Owner-scoped result envelope" },
              "401": { description: "Unauthorized" },
              "403": { description: "Scope denied" },
              "409": { description: "Conflict or incomplete evidence" },
            },
          },
        },
      ]),
    ),
  };
}
export async function privateApiRequest(
  request: Request,
  env: PrivateServiceEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  try {
    if (url.pathname === "/private/openapi.json")
      return Response.json(privateOpenApi(), { headers });
    if (url.pathname === "/private/upload" && request.method === "GET")
      return uploadPage();
    if (url.pathname === "/private/upload" && request.method === "POST") {
      const token = request.headers.get("X-Upload-Ticket") ?? "";
      const filename = decodeURIComponent(
        request.headers.get("X-Filename") ?? "",
      );
      const bytes = await boundedBytes(
        new Response(request.body),
        25 * 1024 * 1024,
      );
      return Response.json(
        { data: await acceptUploadTicket(env, token, filename, bytes) },
        { headers },
      );
    }
    if (url.pathname === "/private/v1/dispatch") {
      const context = await authenticatePrivateBearer(request, env);
      if (request.method !== "POST")
        throw new DossierError("METHOD_NOT_ALLOWED", 405);
      const body = JSON.parse(
        new TextDecoder().decode(
          await boundedBytes(new Response(request.body), 1000000),
        ),
      );
      const dispatch = z
        .object({
          operation: z.enum(Object.keys(routes) as [Route, ...Route[]]),
          arguments: z.record(z.string(), z.unknown()),
        })
        .strict()
        .parse(body);
      return Response.json(
        {
          data: await executePrivateOperation(
            env,
            context,
            dispatch.operation,
            dispatch.arguments,
            url.origin,
          ),
        },
        { headers },
      );
    }
    const name = url.pathname.slice("/private/v1/".length);
    if (
      !url.pathname.startsWith("/private/v1/") ||
      !Object.hasOwn(routes, name)
    )
      throw new DossierError("NOT_FOUND", 404);
    const context = await authenticatePrivateBearer(request, env);
    const route = routes[name as Route];
    if (request.method !== route.method)
      throw new DossierError("METHOD_NOT_ALLOWED", 405);
    const raw =
      route.method === "GET"
        ? Object.fromEntries(
            [...url.searchParams].filter(([, value]) => value !== ""),
          )
        : JSON.parse(
            new TextDecoder().decode(
              await boundedBytes(new Response(request.body), 1000000),
            ),
          );
    const data = await executePrivateOperation(
      env,
      context,
      name as Route,
      raw,
      url.origin,
    );
    return Response.json({ data }, { headers });
  } catch (error) {
    const e =
      error instanceof DossierError
        ? error
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? new DossierError("INVALID_REQUEST", 422)
          : new DossierError("SERVICE_UNAVAILABLE", 503, true);
    return Response.json(
      {
        error: {
          code: e.code,
          retryable: e.retryable,
          recovery:
            e.code === "REVISION_CONFLICT"
              ? "Reload the latest saved state before retrying."
              : "Inspect dossier progress and retry the affected operation.",
        },
      },
      { status: e.status, headers },
    );
  }
}
