import { DossierError } from "./contracts";
import type { DossierRepository } from "./repository";
export async function consumeOwnerLimit(
  repo: DossierRepository,
  name: string,
  limit: number,
  periodMs: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000)
    throw new DossierError("OWNER_BUDGET_UNCONFIGURED", 503);
  const window = Math.floor(repo.now() / periodMs);
  const result = await repo.db
    .prepare(
      "INSERT INTO dossier_limits(owner_id,bucket,count,expires_at) VALUES(?,?,1,?) ON CONFLICT(owner_id,bucket) DO UPDATE SET count=count+1 WHERE count<? RETURNING count",
    )
    .bind(
      repo.context.ownerId,
      `${name}:${window}`,
      (window + 1) * periodMs,
      limit,
    )
    .first();
  if (!result)
    throw new DossierError(
      name === "model-daily" ? "OWNER_DAILY_LIMIT" : "OWNER_RATE_LIMIT",
      429,
      true,
    );
}
