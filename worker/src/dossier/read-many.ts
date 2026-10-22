import type {
  DossierRepository,
  EntityKind,
  Stored,
} from "./repository";

// Keep each readMany aggregate comfortably below the repository's 20 MB cap.
const READ_MANY_BATCH_SIZE = 100;

export async function readManyBatched<T>(
  repo: Pick<DossierRepository, "readMany">,
  kind: EntityKind,
  ids: string[],
  options: { allowMissing?: boolean } = {},
): Promise<Stored<T>[]> {
  const records: Stored<T>[] = [];
  for (let offset = 0; offset < ids.length; offset += READ_MANY_BATCH_SIZE) {
    records.push(
      ...(await repo.readMany<T>(
        kind,
        ids.slice(offset, offset + READ_MANY_BATCH_SIZE),
        options,
      )),
    );
  }
  return records;
}
