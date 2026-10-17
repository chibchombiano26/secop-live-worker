import { z } from "zod/v4";
import { DossierError } from "./contracts";
import { DossierRepository } from "./repository";
import { DATASETS, socrataFetch, type Env } from "../socrata";
import { readSecopDocuments } from "../public/documents.mjs";
import { splitEvidence } from "./extraction";
import { sha256 } from "./downloads";
export type SourceDocument = {
  sourceId: string;
  processId: string;
  name: string;
  url: string | null;
  date?: string;
  size?: number;
};
export type DocumentPage = {
  items: SourceDocument[];
  nextCursor: number | null;
};
export type DocumentVersion = SourceDocument & {
  dossierId: string;
  corpusRevision: number;
  state: string;
  hash?: string;
  fileId?: string;
  error?: string;
  parserVersion?: string;
};
export async function listProcessDocuments(
  env: Env,
  processId: string,
  cursor: number,
): Promise<DocumentPage> {
  const result = await readSecopDocuments(
    { id_del_proceso: processId, offset: cursor, limit: 100 },
    {
      env,
      tenderDataset: DATASETS.procesos,
      documentsDataset: DATASETS.docs,
      socrataFetch,
      stringSchema: () => z.string(),
      numberSchema: () => z.number(),
    },
  );
  if (result.association.status !== "verified")
    throw new DossierError("ASSOCIATION_UNVERIFIED", 409);
  return {
    items: result.data.map((row) => ({
      sourceId: String(row.id_documento),
      processId: String(row.id_del_proceso),
      name: String(row.nombre_archivo ?? "Document"),
      url:
        typeof row.url_descarga_documento === "string"
          ? row.url_descarga_documento
          : null,
      date: String(row.fecha_carga ?? ""),
      size: Number(row.tamanno_archivo) || 0,
    })),
    nextCursor: result.pagination.has_more ? cursor + 100 : null,
  };
}
export async function getProcessDetail(env: Env, processId: string) {
  if (!/^CO1\.REQ\.\d+$/.test(processId))
    throw new DossierError("INVALID_PROCESS");
  const rows = await socrataFetch(
    DATASETS.procesos,
    `SELECT * WHERE id_del_proceso = '${processId}' LIMIT 2`,
    env,
  );
  if (rows.length !== 1) throw new DossierError("TENDER_DETAIL_AMBIGUOUS", 409);
  return rows[0] as Record<string, unknown>;
}
export async function discoverInventory(
  processId: string,
  page: (id: string, cursor: number) => Promise<DocumentPage>,
  checkpoint?: () => Promise<void>,
) {
  async function pass() {
    let cursor: number | null = 0;
    const visited = new Set<number>();
    const docs = new Map<string, SourceDocument>();
    while (cursor !== null) {
      if (visited.has(cursor) || visited.size >= 100)
        throw new DossierError("INVENTORY_UNSTABLE", 409, true);
      visited.add(cursor);
      const result = await page(processId, cursor);
      for (const doc of result.items) {
        if (doc.processId !== processId)
          throw new DossierError("ASSOCIATION_UNVERIFIED", 409);
        if (!/^\d+$/.test(doc.sourceId))
          throw new DossierError("INVALID_DOCUMENT_ID");
        const previous = docs.get(doc.sourceId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(doc))
          throw new DossierError("INVENTORY_UNSTABLE", 409, true);
        docs.set(doc.sourceId, doc);
      }
      if (
        result.nextCursor !== null &&
        (!Number.isSafeInteger(result.nextCursor) || result.nextCursor < 0)
      )
        throw new DossierError("INVENTORY_UNSTABLE", 409, true);
      cursor = result.nextCursor;
      await checkpoint?.();
    }
    return [...docs.values()].sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId),
    );
  }
  const first = await pass();
  const second = await pass();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new DossierError("INVENTORY_UNSTABLE", 409, true);
  return second;
}
export async function refreshInventory(
  repo: DossierRepository,
  dossierId: string,
  adapters: {
    page: (id: string, cursor: number) => Promise<DocumentPage>;
    detail: (id: string) => Promise<Record<string, unknown>>;
    checkpoint?: () => Promise<void>;
  },
) {
  const dossier = await repo.readDossier(dossierId);
  const description = await adapters.detail(dossierId);
  const docs = await discoverInventory(
    dossierId,
    adapters.page,
    adapters.checkpoint,
  );
  const inventoryHash = await sha256(
    JSON.stringify({
      description,
      docs,
      descriptionParser: "official-description-v2",
    }),
  );
  if (dossier.value.inventoryHash === inventoryHash) {
    for (const id of (dossier.value.documentIds ?? []) as string[])
      await repo.enqueueJob({
        kind: "extract",
        targetId: id,
        key: `extract:${id}`,
      });
    return dossier;
  }
  const corpusRevision = Number(dossier.value.corpusRevision ?? 0) + 1;
  const ids: string[] = [];
  for (const doc of docs) {
    const id = await sha256(`${dossierId}:${corpusRevision}:${doc.sourceId}`);
    ids.push(id);
    await repo.upsert<DocumentVersion>("document", id, {
      ...doc,
      dossierId,
      corpusRevision,
      state: doc.url ? "pending" : "blocked",
      ...(!doc.url ? { error: "OFFICIAL_LINK_MISSING" } : {}),
    });
  }
  const descriptionId = `description:${dossierId}:${corpusRevision}`;
  await repo.upsert("document", descriptionId, {
    dossierId,
    corpusRevision,
    sourceId: descriptionId,
    name: "Official process description",
    url: null,
    processId: dossierId,
    state: "ready",
    parserVersion: "official-description-v2",
  });
  for (const chunk of splitEvidence(
    {
      parserVersion: "official-description-v2",
      pages: [
        {
          section: "Official process description",
          text: Object.entries(description)
            .map(
              ([key, value]) =>
                `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}`,
            )
            .join("\n"),
        },
      ],
      warnings: [],
      complete: true,
    },
    descriptionId,
  ))
    await repo.upsert("chunk", `${descriptionId}.${chunk.index}`, chunk);
  const updated = await repo.save(
    "dossier",
    dossierId,
    {
      ...dossier.value,
      description,
      descriptionId,
      inventoryHash,
      documentIds: ids,
      corpusRevision,
      state: "processing",
      coverage: {
        inventoryComplete: true,
        total: docs.length,
        warning: "PUBLIC_CATALOG_COVERAGE_ONLY",
      },
    },
    dossier.revision,
  );
  for (const id of ids)
    await repo.enqueueJob({
      kind: "extract",
      targetId: id,
      key: `extract:${id}`,
    });
  return updated;
}
