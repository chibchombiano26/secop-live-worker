import { DossierError, type PrivateContext } from "./contracts";
import { retryTransientD1 } from "./d1-retry";
import { sha256 } from "./downloads";
export type DossierEnv = {
  DOSSIER_DB?: D1Database;
  DOSSIER_FILES?: R2Bucket;
  DOSSIER_QUEUE?: Queue<{ ownerId: string; jobId: string }>;
};
export type EntityKind =
  | "dossier"
  | "document"
  | "chunk"
  | "report"
  | "requirement"
  | "company"
  | "evidence"
  | "assessment"
  | "review"
  | "task"
  | "conversation"
  | "message"
  | "upload"
  | "source"
  | "proposal"
  | "expert_plan"
  | "expert_memory"
  | "expert_receipt";
export type Stored<T> = {
  id: string;
  revision: number;
  value: T;
  updatedAt: number;
};
export type Job = {
  id: string;
  kind:
    | "inventory"
    | "extract"
    | "synthesize"
    | "assess"
    | "chat"
    | "company_facts";
  targetId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  lease: string | null;
  leaseUntil: number | null;
  progress: Record<string, unknown>;
  error: string | null;
};
const jobColumns =
  "id,kind,target_id AS targetId,state,attempts,lease,lease_until AS leaseUntil,progress,error";
const READ_MANY_CHUNK_SIZE = 80;
const MAX_READ_MANY_IDS = 5000;
const MAX_RECORD_CHARS = 500000;
const MAX_AGGREGATE_BYTES = 20000000;
const MAX_REPORT_BYTES = 32000000;
const AGGREGATE_POINTER_KEY = "__saviaAggregateBlob";
const AGGREGATE_KINDS = new Set<EntityKind>([
  "report",
  "assessment",
  "message",
]);
const AGGREGATE_INDEX_FIELDS = [
  "documentVersionId",
  "dossierId",
  "companyId",
  "assessmentId",
  "conversationId",
  "hash",
] as const;
type AggregatePointerV1 = {
  version: 1;
  kind: "report" | "assessment" | "message";
  key: string;
  length: number;
  sha256: string;
};
type AggregatePart = { key: string; length: number; sha256: string };
type AggregatePointerV2 = {
  version: 2;
  kind: "report";
  length: number;
  sha256: string;
  parts: AggregatePart[];
};
type AggregatePointer = AggregatePointerV1 | AggregatePointerV2;
const sha256Pattern = /^[a-f0-9]{64}$/;
function aggregatePointer(
  value: unknown,
  kind: EntityKind,
): AggregatePointer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pointer = (value as Record<string, unknown>)[AGGREGATE_POINTER_KEY];
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer))
    return null;
  const candidate = pointer as Record<string, unknown>;
  if (candidate.kind !== kind || !Number.isSafeInteger(candidate.length))
    return null;
  const length = candidate.length as number;
  if (typeof candidate.sha256 !== "string" || !sha256Pattern.test(candidate.sha256))
    return null;
  if (candidate.version === 1) {
    const prefix = `${kind}-v1.`;
    if (
      length < 0 || length > MAX_AGGREGATE_BYTES ||
      typeof candidate.key !== "string" ||
      !new RegExp(`^${prefix}[a-f0-9]{64}$`).test(candidate.key) ||
      candidate.sha256 !== candidate.key.slice(prefix.length)
    ) return null;
    return candidate as AggregatePointerV1;
  }
  if (candidate.version !== 2 || kind !== "report" ||
      length <= MAX_AGGREGATE_BYTES || length > MAX_REPORT_BYTES ||
      !Array.isArray(candidate.parts) ||
      candidate.parts.length < 2 || candidate.parts.length > 3)
    return null;
  let partBytes = 0;
  for (const part of candidate.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) return null;
    const entry = part as Record<string, unknown>;
    if (typeof entry.sha256 !== "string" || !sha256Pattern.test(entry.sha256) ||
        entry.key !== `report-v2.${entry.sha256}` ||
        !Number.isSafeInteger(entry.length) ||
        (entry.length as number) < 1 || (entry.length as number) > MAX_AGGREGATE_BYTES)
      return null;
    partBytes += entry.length as number;
  }
  return partBytes === length ? candidate as AggregatePointerV2 : null;
}
function isAggregateValue(kind: EntityKind, value: unknown) {
  return (
    AGGREGATE_KINDS.has(kind) &&
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, AGGREGATE_POINTER_KEY)
  );
}
function storedRecordBytes(kind: EntityKind, serialized: string) {
  const value = JSON.parse(serialized) as unknown;
  if (isAggregateValue(kind, value)) {
    const pointer = aggregatePointer(value, kind);
    if (!pointer) throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
    return pointer.length;
  }
  return new TextEncoder().encode(serialized).byteLength;
}
export class DossierRepository {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  constructor(
    readonly env: DossierEnv,
    readonly context: PrivateContext,
    readonly now: () => number = Date.now,
  ) {
    if (!env.DOSSIER_DB || !env.DOSSIER_FILES)
      throw new DossierError("DOSSIER_UNCONFIGURED", 503);
    this.db = env.DOSSIER_DB;
    this.bucket = env.DOSSIER_FILES;
  }
  async read<T>(kind: EntityKind, id: string): Promise<Stored<T>> {
    const row = await this.db
      .prepare(
        "SELECT id,revision,value,updated_at AS updatedAt FROM dossier_records WHERE owner_id=? AND kind=? AND id=?",
      )
      .bind(this.context.ownerId, kind, id)
      .first<{
        id: string;
        revision: number;
        value: string;
        updatedAt: number;
      }>();
    if (!row) throw new DossierError("NOT_FOUND", 404);
    return {
      ...row,
      value: (await this.hydrate(kind, JSON.parse(row.value))) as T,
    };
  }
  private async hydrate(kind: EntityKind, value: unknown) {
    if (!isAggregateValue(kind, value)) return value;
    const pointer = aggregatePointer(value, kind);
    if (!pointer) throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
    const readPart = async (part: AggregatePart) => {
      const head = await this.headFile(part.key);
      if (!head) throw new DossierError("AGGREGATE_BLOB_MISSING", 500);
      if (head.size !== part.length || head.size > MAX_AGGREGATE_BYTES)
        throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
      const file = await this.getFile(part.key);
      if (!file) throw new DossierError("AGGREGATE_BLOB_MISSING", 500);
      if (file.size !== part.length || file.size > MAX_AGGREGATE_BYTES)
        throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
      let data: Uint8Array;
      try {
        data = new Uint8Array(await file.arrayBuffer());
      } catch {
        throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
      }
      if (data.byteLength !== part.length || (await sha256(data)) !== part.sha256)
        throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
      return data;
    };
    let bytes: Uint8Array;
    if (pointer.version === 1) {
      bytes = await readPart(pointer);
    } else {
      bytes = new Uint8Array(pointer.length);
      let offset = 0;
      for (const part of pointer.parts) {
        bytes.set(await readPart(part), offset);
        offset += part.length;
      }
    }
    if (
      bytes.byteLength !== pointer.length ||
      (await sha256(bytes)) !== pointer.sha256
    )
      throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // Release the reconstructed byte buffer before parsing a large JSON
      // object. The decoder's string and hydrated object can both be large.
      bytes = new Uint8Array(0);
      const hydrated = JSON.parse(text) as unknown;
      if (!hydrated || typeof hydrated !== "object" || Array.isArray(hydrated))
        throw new Error("invalid aggregate payload");
      const pointerRecord = value as Record<string, unknown>;
      const payloadRecord = hydrated as Record<string, unknown>;
      for (const field of AGGREGATE_INDEX_FIELDS) {
        const fieldValue = payloadRecord[field];
        const shouldIndex =
          fieldValue === null ||
          typeof fieldValue === "string" ||
          typeof fieldValue === "number" ||
          typeof fieldValue === "boolean";
        if (
          shouldIndex !== Object.hasOwn(pointerRecord, field) ||
          (shouldIndex && pointerRecord[field] !== fieldValue)
        )
          throw new Error("invalid aggregate index");
      }
      return hydrated;
    } catch {
      throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
    }
  }
  private async serializeRecord(kind: EntityKind, value: unknown) {
    let serialized = JSON.stringify(value);
    if (typeof serialized !== "string")
      throw new DossierError("INVALID_RECORD", 400);
    if (serialized.length > MAX_RECORD_CHARS && AGGREGATE_KINDS.has(kind)) {
      const aggregateKind = kind as AggregatePointer["kind"];
      const bytes = new TextEncoder().encode(serialized);
      const limit = kind === "report" ? MAX_REPORT_BYTES : MAX_AGGREGATE_BYTES;
      if (bytes.byteLength > limit)
        throw new DossierError("RECORD_TOO_LARGE", 413);
      const digest = await sha256(bytes);
      const storePart = async (key: string, data: Uint8Array, expected: string) => {
        const existing = await this.getFile(key);
        if (existing) {
          if (existing.size !== data.byteLength || existing.size > MAX_AGGREGATE_BYTES)
            throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
          const existingBytes = new Uint8Array(await existing.arrayBuffer());
          if (existingBytes.byteLength !== data.byteLength ||
              (await sha256(existingBytes)) !== expected)
            throw new DossierError("AGGREGATE_BLOB_CORRUPT", 500);
        } else {
          await this.putFile(key, data, "application/json");
        }
      };
      let pointer: AggregatePointer;
      if (bytes.byteLength <= MAX_AGGREGATE_BYTES) {
        const key = `${aggregateKind}-v1.${digest}`;
        await storePart(key, bytes, digest);
        pointer = { version: 1, kind: aggregateKind, key,
          length: bytes.byteLength, sha256: digest };
      } else {
        const parts: AggregatePart[] = [];
        for (let offset = 0; offset < bytes.byteLength; offset += MAX_AGGREGATE_BYTES) {
          const chunk = bytes.subarray(offset, offset + MAX_AGGREGATE_BYTES);
          const chunkDigest = await sha256(chunk);
          const key = `report-v2.${chunkDigest}`;
          await storePart(key, chunk, chunkDigest);
          parts.push({ key, length: chunk.byteLength, sha256: chunkDigest });
        }
        pointer = { version: 2, kind: "report", length: bytes.byteLength,
          sha256: digest, parts };
      }
      const source =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const index: Record<string, string | number | boolean | null> = {};
      for (const field of AGGREGATE_INDEX_FIELDS) {
        const fieldValue = source[field];
        if (
          fieldValue === null ||
          typeof fieldValue === "string" ||
          typeof fieldValue === "number" ||
          typeof fieldValue === "boolean"
        )
          index[field] = fieldValue;
      }
      serialized = JSON.stringify({
        ...index,
        [AGGREGATE_POINTER_KEY]: pointer,
      });
    }
    if (serialized.length > MAX_RECORD_CHARS)
      throw new DossierError("RECORD_TOO_LARGE", 413);
    return serialized;
  }
  async readMany<T>(
    kind: EntityKind,
    ids: string[],
    options: { allowMissing?: boolean; retryNetworkLoss?: boolean } = {},
  ): Promise<Stored<T>[]> {
    if (
      ids.length > MAX_READ_MANY_IDS ||
      ids.some((id) => typeof id !== "string" || !id)
    )
      throw new DossierError("INVALID_BATCH", 400);
    if (!ids.length) return [];

    const requestedIds = [...new Set(ids)];
    const found = new Map<
      string,
      Omit<Stored<T>, "value"> & { value: string }
    >();
    let size = 0;
    for (
      let offset = 0;
      offset < requestedIds.length;
      offset += READ_MANY_CHUNK_SIZE
    ) {
      const chunk = requestedIds.slice(offset, offset + READ_MANY_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const query = () =>
        this.db
          .prepare(
            `SELECT id,revision,value,updated_at AS updatedAt FROM dossier_records WHERE owner_id=? AND kind=? AND id IN (${placeholders})`,
          )
          .bind(this.context.ownerId, kind, ...chunk)
          .all<{
            id: string;
            revision: number;
            value: string;
            updatedAt: number;
          }>();
      const rows = options.retryNetworkLoss
        ? await retryTransientD1(query)
        : await query();
      for (const row of rows.results) {
        size += storedRecordBytes(kind, row.value);
        if (size > (kind === "report" ? MAX_REPORT_BYTES : MAX_AGGREGATE_BYTES))
          throw new DossierError("CORPUS_CAPACITY_LIMIT", 413);
        found.set(row.id, row);
      }
    }

    if (!options.allowMissing && requestedIds.some((id) => !found.has(id)))
      throw new DossierError("NOT_FOUND", 404);
    const hydrated = new Map<string, Promise<T>>();
    return Promise.all(
      ids.flatMap((id) => {
        const record = found.get(id);
        if (!record) return [];
        let value = hydrated.get(id);
        if (!value) {
          value = this.hydrate(kind, JSON.parse(record.value)).then(
            (result) => result as T,
          );
          hydrated.set(id, value);
        }
        return [value.then((result) => ({ ...record, value: result }))];
      }),
    );
  }
  async readAnalysisCache(): Promise<Stored<unknown>[]> {
    const rows = await this.db
      .prepare(
        "SELECT id FROM dossier_records WHERE owner_id=? AND kind='report' AND (substr(id,1,5)='part.' OR substr(id,1,6)='joint.') ORDER BY id LIMIT 5001",
      )
      .bind(this.context.ownerId)
      .all<{ id: string }>();
    if (rows.results.length > 5000)
      throw new DossierError("REPORT_CACHE_CAPACITY_LIMIT", 413);
    return this.readMany(
      "report",
      rows.results.map((row) => row.id),
    );
  }
  async writeAnalysisCache(id: string, value: unknown) {
    if (
      typeof id !== "string" ||
      id.length > 200 ||
      !/^(part|joint)\..+/u.test(id)
    )
      throw new DossierError("INVALID_BATCH", 400);
    const serialized = await this.serializeRecord("report", value);
    await retryTransientD1(() =>
      this.db
        .prepare(
          "INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) VALUES(?,'report',?,1,?,?) ON CONFLICT(owner_id,kind,id) DO UPDATE SET value=excluded.value,revision=dossier_records.revision+1,updated_at=excluded.updated_at WHERE dossier_records.value<>excluded.value",
        )
        .bind(this.context.ownerId, id, serialized, this.now())
        .run(),
    );
  }
  async upsertMany<T>(
    kind: EntityKind,
    entries: Array<{ id: string; value: T }>,
  ): Promise<void> {
    if (
      kind !== "requirement" ||
      !Array.isArray(entries) ||
      entries.length > MAX_READ_MANY_IDS ||
      entries.some(
        (entry) =>
          !entry ||
          typeof entry.id !== "string" ||
          !entry.id ||
          entry.id.length > 200,
      ) ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length
    )
      throw new DossierError("INVALID_BATCH", 400);
    if (!entries.length) return;

    const serialized = entries.map((entry) => JSON.stringify(entry.value));
    if (
      serialized.some(
        (value) => typeof value !== "string" || value.length > MAX_RECORD_CHARS,
      )
    )
      throw new DossierError("RECORD_TOO_LARGE", 413);
    const inputBytes = serialized.reduce(
      (total, value) => total + new TextEncoder().encode(value!).byteLength,
      0,
    );
    if (inputBytes > MAX_AGGREGATE_BYTES)
      throw new DossierError("CORPUS_CAPACITY_LIMIT", 413);

    const current = await this.readMany<T>(
      kind,
      entries.map((entry) => entry.id),
      { allowMissing: true },
    );
    const byId = new Map(current.map((record) => [record.id, record]));
    const timestamp = this.now();
    const statements = entries.map((entry, index) => {
      const existing = byId.get(entry.id);
      return existing
        ? this.db
            .prepare(
              "UPDATE dossier_records SET value=?,revision=revision+1,updated_at=? WHERE owner_id=? AND kind=? AND id=? AND revision=?",
            )
            .bind(
              serialized[index],
              timestamp,
              this.context.ownerId,
              kind,
              entry.id,
              existing.revision,
            )
        : this.db
            .prepare(
              "INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT DO NOTHING",
            )
            .bind(
              this.context.ownerId,
              kind,
              entry.id,
              serialized[index],
              timestamp,
            );
    });
    for (let offset = 0; offset < statements.length; offset += 80) {
      const batch = statements.slice(offset, offset + 80);
      const results = await this.db.batch(batch);
      if (
        results.length !== batch.length ||
        results.some((result) => result.meta.changes !== 1)
      )
        throw new DossierError("REVISION_CONFLICT", 409);
    }
  }
  async list<T>(
    kind: EntityKind,
    offset = 0,
    limit = 100,
  ): Promise<Stored<T>[]> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new DossierError("INVALID_PAGE");
    const rows = await this.db
      .prepare(
        "SELECT id,revision,value,updated_at AS updatedAt FROM dossier_records WHERE owner_id=? AND kind=? ORDER BY id LIMIT ? OFFSET ?",
      )
      .bind(this.context.ownerId, kind, limit, offset)
      .all<{
        id: string;
        revision: number;
        value: string;
        updatedAt: number;
      }>();
    const size = rows.results.reduce(
      (total, row) => total + storedRecordBytes(kind, row.value),
      0,
    );
    if (size > (kind === "report" ? MAX_REPORT_BYTES : MAX_AGGREGATE_BYTES))
      throw new DossierError("CORPUS_CAPACITY_LIMIT", 413);
    return Promise.all(
      rows.results.map(async (r) => ({
        ...r,
        value: (await this.hydrate(kind, JSON.parse(r.value))) as T,
      })),
    );
  }
  async all<T>(kind: EntityKind): Promise<Stored<T>[]> {
    const rows: Stored<T>[] = [];
    for (let page = 0; ; page += 200) {
      const items = await this.list<T>(kind, page, 200);
      rows.push(...items);
      if (items.length < 200) return rows;
      if (rows.length >= 50000) throw new DossierError("RESOURCE_LIMIT", 413);
    }
  }
  async allMatching<T>(
    kind: EntityKind,
    field:
      "documentVersionId" | "dossierId" | "companyId" | "assessmentId" | "hash",
    values: string[],
  ): Promise<Stored<T>[]> {
    if (!values.length) return [];
    const output: Stored<T>[] = [];
    let size = 0;
    for (let offset = 0; ; offset += 200) {
      const rows = await this.db
        .prepare(
          "SELECT id,revision,value,updated_at AS updatedAt FROM dossier_records WHERE owner_id=? AND kind=? AND json_extract(value,?) IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 200 OFFSET ?",
        )
        .bind(
          this.context.ownerId,
          kind,
          `$.${field}`,
          JSON.stringify(values),
          offset,
        )
        .all<{
          id: string;
          revision: number;
          value: string;
          updatedAt: number;
        }>();
      for (const row of rows.results) {
        size += storedRecordBytes(kind, row.value);
        if (size > (kind === "report" ? MAX_REPORT_BYTES : MAX_AGGREGATE_BYTES))
          throw new DossierError("CORPUS_CAPACITY_LIMIT", 413);
        output.push({ ...row, value: JSON.parse(row.value) as T });
      }
      if (rows.results.length < 200)
        return Promise.all(
          output.map(async (row) => ({
            ...row,
            value: (await this.hydrate(kind, row.value)) as T,
          })),
        );
      if (output.length >= 50000) throw new DossierError("RESOURCE_LIMIT", 413);
    }
  }
  async save<T>(
    kind: EntityKind,
    id: string,
    value: T,
    expectedRevision: number,
  ): Promise<Stored<T>> {
    const serialized = await this.serializeRecord(kind, value);
    const updatedAt = this.now();
    const result =
      expectedRevision === 0
        ? await this.db
            .prepare(
              "INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT DO NOTHING",
            )
            .bind(this.context.ownerId, kind, id, serialized, updatedAt)
            .run()
        : await this.db
            .prepare(
              "UPDATE dossier_records SET value=?,revision=revision+1,updated_at=? WHERE owner_id=? AND kind=? AND id=? AND revision=?",
            )
            .bind(
              serialized,
              updatedAt,
              this.context.ownerId,
              kind,
              id,
              expectedRevision,
            )
            .run();
    if (result.meta.changes !== 1)
      throw new DossierError("REVISION_CONFLICT", 409);
    // A segmented report already occupies substantial memory in its parsed
    // form. Rehydrating it in the same invocation would hold another complete
    // byte buffer and parsed copy while synthesis still owns `value`.
    if (
      kind === "report" &&
      aggregatePointer(JSON.parse(serialized), kind)?.version === 2
    )
      return { id, revision: expectedRevision + 1, value, updatedAt };
    return this.read<T>(kind, id);
  }
  async commitConversationTurn(
    id: string,
    expectedRevision: number,
    key: string,
    turnId: string,
    turn: unknown,
    value: unknown,
  ) {
    const owner = this.context.ownerId;
    const conversationValue = JSON.stringify(value);
    if (
      typeof conversationValue !== "string" ||
      conversationValue.length > MAX_RECORD_CHARS
    )
      throw new DossierError("RECORD_TOO_LARGE", 413);
    const messageValue = await this.serializeRecord("message", turn);
    const result = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) SELECT ?,'message',?,1,?,? WHERE EXISTS(SELECT 1 FROM dossier_records WHERE owner_id=? AND kind='conversation' AND id=? AND revision=? AND json_extract(value,'$.pending.key')=?)",
        )
        .bind(
          owner,
          turnId,
          messageValue,
          this.now(),
          owner,
          id,
          expectedRevision,
          key,
        ),
      this.db
        .prepare(
          "UPDATE dossier_records SET value=?,revision=revision+1,updated_at=? WHERE owner_id=? AND kind='conversation' AND id=? AND revision=? AND json_extract(value,'$.pending.key')=?",
        )
        .bind(conversationValue, this.now(), owner, id, expectedRevision, key),
    ]);
    if (result.some((r) => r.meta.changes !== 1))
      throw new DossierError("CONVERSATION_LEASE_LOST", 409);
    return this.read("conversation", id);
  }
  async upsert<T>(kind: EntityKind, id: string, value: T) {
    let revision = 0;
    if (kind === "report") {
      // Synthesis may retry after publishing a segmented report. Reading the
      // existing payload only to obtain its revision would hydrate a second
      // complete report while the new one is still in memory.
      const row = await this.db
        .prepare(
          "SELECT revision FROM dossier_records WHERE owner_id=? AND kind=? AND id=?",
        )
        .bind(this.context.ownerId, kind, id)
        .first<{ revision: number }>();
      revision = row?.revision ?? 0;
    } else {
      try {
        revision = (await this.read(kind, id)).revision;
      } catch (e) {
        if (!(e instanceof DossierError) || e.code !== "NOT_FOUND") throw e;
      }
    }
    return this.save(kind, id, value, revision);
  }
  async createOrGetDossier(processId: string) {
    if (!/^CO1\.REQ\.\d+$/.test(processId))
      throw new DossierError("INVALID_PROCESS");
    try {
      return await this.read<Record<string, unknown>>("dossier", processId);
    } catch (e) {
      if (!(e instanceof DossierError) || e.code !== "NOT_FOUND") throw e;
    }
    try {
      return await this.save(
        "dossier",
        processId,
        {
          processId,
          corpusRevision: 0,
          state: "new",
          coverage: { inventoryComplete: false },
          description: null,
        },
        0,
      );
    } catch (e) {
      if (e instanceof DossierError && e.code === "REVISION_CONFLICT")
        return this.read<Record<string, unknown>>("dossier", processId);
      throw e;
    }
  }
  readDossier(id: string) {
    return this.read<Record<string, unknown>>("dossier", id);
  }
  private fileKey(id: string) {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(id))
      throw new DossierError("INVALID_FILE");
    return `${this.context.ownerId}/${id}`;
  }
  async putFile(id: string, bytes: Uint8Array, mime: string) {
    await this.bucket.put(this.fileKey(id), bytes, {
      httpMetadata: { contentType: mime },
    });
  }
  getFile(id: string) {
    return this.bucket.get(this.fileKey(id));
  }
  headFile(id: string) {
    return this.bucket.head(this.fileKey(id));
  }
  async deleteFile(id: string) {
    await this.bucket.delete(this.fileKey(id));
  }
  async enqueueJob(input: {
    kind: Job["kind"];
    targetId: string;
    key: string;
    resumeTerminalSynthesis?: boolean;
  }) {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        "INSERT INTO dossier_jobs(owner_id,id,kind,target_id,idempotency_key,state,available_at,created_at) VALUES(?,?,?,?,?,'queued',?,?) ON CONFLICT DO NOTHING",
      )
      .bind(
        this.context.ownerId,
        id,
        input.kind,
        input.targetId,
        input.key,
        this.now(),
        this.now(),
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT ${jobColumns} FROM dossier_jobs WHERE owner_id=? AND idempotency_key=?`,
      )
      .bind(this.context.ownerId, input.key)
      .first();
    if (!row) throw new DossierError("JOB_CREATE_FAILED", 503);
    let job = this.parseJob(row);
    let shouldDispatch = job.id === id;
    if (
      input.resumeTerminalSynthesis &&
      input.kind === "synthesize" &&
      job.kind === "synthesize" &&
      job.targetId === input.targetId &&
      (job.state === "failed" || job.state === "cancelled")
    ) {
      const resumedAt = this.now();
      const progress = { ...job.progress, stage: "queued", resumeAt: resumedAt };
      const result = await this.db
        .prepare(
          "UPDATE dossier_jobs SET state='queued',attempts=0,available_at=?,dispatched_at=NULL,error=NULL,lease=NULL,lease_until=NULL,progress=? WHERE owner_id=? AND id=? AND kind='synthesize' AND target_id=? AND state IN ('failed','cancelled')",
        )
        .bind(
          resumedAt,
          JSON.stringify(progress),
          this.context.ownerId,
          job.id,
          input.targetId,
        )
        .run();
      shouldDispatch ||= result.meta.changes > 0;
      job = await this.readJob(job.id);
    }
    // Persist first; the cron dispatcher recovers any unsuccessful immediate send.
    if (shouldDispatch && this.env.DOSSIER_QUEUE) {
      try {
        await this.env.DOSSIER_QUEUE.send({
          ownerId: this.context.ownerId,
          jobId: job.id,
        });
        await this.db
          .prepare(
            "UPDATE dossier_jobs SET dispatched_at=? WHERE owner_id=? AND id=?",
          )
          .bind(this.now(), this.context.ownerId, job.id)
          .run();
      } catch {
        /* Durable outbox remains eligible for recovery. */
      }
    }
    return job;
  }
  private parseJob(row: Record<string, unknown>): Job {
    return { ...row, progress: JSON.parse(String(row.progress)) } as Job;
  }
  async readJob(id: string) {
    const row = await this.db
      .prepare(
        `SELECT ${jobColumns} FROM dossier_jobs WHERE owner_id=? AND id=?`,
      )
      .bind(this.context.ownerId, id)
      .first();
    if (!row) throw new DossierError("NOT_FOUND", 404);
    return this.parseJob(row);
  }
  async listDispatchableJobs() {
    const rows = await this.db
      .prepare(
        `SELECT ${jobColumns} FROM dossier_jobs WHERE owner_id=? AND attempts<5 AND ((state='queued' AND available_at<=?) OR (state='running' AND lease_until<=?)) ORDER BY created_at LIMIT 100`,
      )
      .bind(this.context.ownerId, this.now(), this.now())
      .all();
    return rows.results.map((r) => this.parseJob(r));
  }
  async claimJob(id: string) {
    const lease = crypto.randomUUID();
    const res = await this.db
      .prepare(
        "UPDATE dossier_jobs SET state='running',lease=?,lease_until=?,attempts=attempts+1 WHERE owner_id=? AND id=? AND attempts<5 AND ((state='queued' AND available_at<=?) OR (state='running' AND lease_until<=?))",
      )
      .bind(
        lease,
        this.now() + 120000,
        this.context.ownerId,
        id,
        this.now(),
        this.now(),
      )
      .run();
    return res.meta.changes === 1 ? this.readJob(id) : null;
  }
  async checkpointJob(
    id: string,
    lease: string,
    progress: Record<string, unknown>,
  ) {
    const res = await retryTransientD1(() =>
      this.db
        .prepare(
          "UPDATE dossier_jobs SET progress=?,lease_until=? WHERE owner_id=? AND id=? AND state='running' AND lease=? AND lease_until>?",
        )
        .bind(
          JSON.stringify(progress),
          this.now() + 120000,
          this.context.ownerId,
          id,
          lease,
          this.now(),
        )
        .run(),
    );
    if (res.meta.changes !== 1) throw new DossierError("LEASE_LOST", 409);
  }
  async yieldJob(id: string, lease: string, delayMs: number, stage: string) {
    const job = await this.readJob(id);
    const resumeAt = this.now() + delayMs;
    const result = await this.db
      .prepare(
        "UPDATE dossier_jobs SET state='queued',attempts=max(0,attempts-1),lease=NULL,lease_until=NULL,available_at=?,dispatched_at=NULL,error=NULL,progress=? WHERE owner_id=? AND id=? AND state='running' AND lease=? AND lease_until>?",
      )
      .bind(
        resumeAt,
        JSON.stringify({ ...job.progress, stage, resumeAt }),
        this.context.ownerId,
        id,
        lease,
        this.now(),
      )
      .run();
    if (result.meta.changes !== 1) throw new DossierError("LEASE_LOST", 409);
  }
  async completeJob(id: string, lease: string) {
    const res = await this.db
      .prepare(
        "UPDATE dossier_jobs SET state='succeeded',error=NULL,lease=NULL,lease_until=NULL WHERE owner_id=? AND id=? AND state='running' AND lease=? AND lease_until>?",
      )
      .bind(this.context.ownerId, id, lease, this.now())
      .run();
    if (res.meta.changes !== 1) throw new DossierError("LEASE_LOST", 409);
  }
  async failJob(id: string, lease: string, code: string, retryable: boolean) {
    const job = await this.readJob(id);
    const retry = retryable && job.attempts < 5;
    const res = await this.db
      .prepare(
        "UPDATE dossier_jobs SET state=?,error=?,available_at=?,lease=NULL,lease_until=NULL,dispatched_at=NULL WHERE owner_id=? AND id=? AND state='running' AND lease=? AND lease_until>?",
      )
      .bind(
        retry ? "queued" : "failed",
        code,
        this.now() + Math.min(60000, 1000 * 2 ** job.attempts),
        this.context.ownerId,
        id,
        lease,
        this.now(),
      )
      .run();
    if (res.meta.changes !== 1) throw new DossierError("LEASE_LOST", 409);
  }
  async cancelJob(id: string) {
    await this.readJob(id);
    await this.db
      .prepare(
        "UPDATE dossier_jobs SET state='cancelled',lease=NULL,lease_until=NULL WHERE owner_id=? AND id=? AND state IN ('queued','running')",
      )
      .bind(this.context.ownerId, id)
      .run();
  }
}
