import { DossierRepository, type DossierEnv } from "./repository";
import { PRIVATE_SCOPES, DossierError } from "./contracts";
import type { DocumentVersion } from "./inventory";
/** Optional original-file retention; extracted evidence and audit history remain. */
export async function sweepOriginalRetention(
  env: DossierEnv & { ORIGINAL_RETENTION_DAYS?: string },
  now = Date.now(),
) {
  if (!env.DOSSIER_DB || !env.DOSSIER_FILES || !env.ORIGINAL_RETENTION_DAYS)
    return;
  const days = Number(env.ORIGINAL_RETENTION_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new DossierError("RETENTION_UNCONFIGURED", 503);
  const rows = await env.DOSSIER_DB.prepare(
    "SELECT owner_id AS ownerId,id FROM dossier_records WHERE kind='document' AND json_extract(value,'$.fileId') IS NOT NULL AND json_extract(value,'$.originalSavedAt') IS NOT NULL AND json_extract(value,'$.originalSavedAt')<? LIMIT 20",
  )
    .bind(now - days * 86400000)
    .all<{ ownerId: string; id: string }>();
  for (const row of rows.results) {
    const repo = new DossierRepository(
      env,
      { ownerId: row.ownerId, scopes: [...PRIVATE_SCOPES] },
      () => now,
    );
    const doc = await repo.read<DocumentVersion>("document", row.id);
    if (!doc.value.fileId) continue;
    await repo.deleteFile(doc.value.fileId);
    await repo.save(
      "document",
      doc.id,
      { ...doc.value, fileId: undefined, originalPurgedAt: now },
      doc.revision,
    );
  }
}

/** Delete expired generated proposal files and their private ticket records. */
export async function sweepExpiredProposals(env: DossierEnv, now = Date.now()) {
  if (!env.DOSSIER_DB || !env.DOSSIER_FILES) return;
  const rows = await env.DOSSIER_DB.prepare(
    "SELECT owner_id AS ownerId,id FROM dossier_records WHERE kind='proposal' AND json_extract(value,'$.expiresAt')<=? LIMIT 20",
  )
    .bind(now)
    .all<{ ownerId: string; id: string }>();
  for (const row of rows.results) {
    const repo = new DossierRepository(
      env,
      { ownerId: row.ownerId, scopes: [...PRIVATE_SCOPES] },
      () => now,
    );
    try {
      const ticket = await repo.read<{ fileId?: string }>("proposal", row.id);
      if (ticket.value.fileId) await repo.deleteFile(ticket.value.fileId);
    } catch (error) {
      if (!(error instanceof DossierError) || error.code !== "NOT_FOUND")
        throw error;
    }
    await repo.db
      .prepare(
        "DELETE FROM dossier_records WHERE owner_id=? AND kind='proposal' AND id=?",
      )
      .bind(row.ownerId, row.id)
      .run();
  }
}
