import type { EvidenceChunk } from "./extraction";
import type { DossierRepository } from "./repository";
import { sha256 } from "./downloads";
import { consumeOwnerLimit } from "./limits";
import { DossierError } from "./contracts";

const MODEL = "@cf/baai/bge-m3";
const DIMENSIONS = 1024;
const PIECE_SIZE = 2000;
const PIECE_OVERLAP = 200;
const BATCH_SIZE = 16;
const MAX_BATCHES_PER_CALL = 4;
const MAX_SOURCE_CHUNKS = 1000;
const MAX_EVIDENCE = 10;
const QUERY_LIMIT = 40;
const TIMEOUT_MS = 20000;

export type RetrievalVector = {
  id: string;
  values: number[];
  namespace: string;
  metadata: Record<string, string>;
};

export interface DossierVectorIndex {
  upsert(vectors: RetrievalVector[]): Promise<unknown>;
  query(
    vector: number[],
    options: {
      namespace: string;
      topK: number;
      filter: Record<string, string>;
      returnMetadata: "all";
    },
  ): Promise<{
    matches?: Array<{
      id: string;
      namespace?: string;
      metadata?: Record<string, unknown>;
      score?: number;
    }>;
  }>;
  describe?(): Promise<{ processedUpToMutation?: unknown }>;
  getByIds?(ids: string[]): Promise<
    Array<{
      id: string;
      namespace?: string;
      metadata?: Record<string, unknown>;
    }>
  >;
}

export interface RetrievalEnv {
  AI?: {
    run(
      model: string,
      input: { text: string[] },
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
  DOSSIER_VECTORS?: DossierVectorIndex;
}

export type TenderRetrieval = {
  mode: "hybrid" | "lexical";
  namespace?: string;
  reason?:
    | "vector_binding_missing"
    | "index_pending"
    | "embedding_failed"
    | "vector_search_failed"
    | "no_vector_matches";
  indexedPieces: number;
  totalPieces: number;
  sourceChunksScanned: number;
  sourceChunksTotal: number;
  semanticMatches: number;
  indexingSubmitted: boolean;
  visibilityConfirmed: boolean;
  complete: boolean;
  partial: boolean;
};

type Piece = {
  id: string;
  sourceRef: string;
  text: string;
  chunkIndex: number;
  part: number;
  metadata: Record<string, string>;
};
type Checkpoint = {
  schema: 1;
  corpusHash: string;
  namespace: string;
  nextBatch: number;
  totalBatches: number;
  lastMutationId?: string;
  dossierRevision?: number;
};

function tokenize(value: string) {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

const SPANISH_FUNCTION_WORDS = new Set([
  "a",
  "al",
  "algo",
  "como",
  "con",
  "cual",
  "cuando",
  "cuanta",
  "cuantas",
  "cuanto",
  "cuantos",
  "de",
  "del",
  "desde",
  "donde",
  "el",
  "ella",
  "ellas",
  "ellos",
  "en",
  "entre",
  "era",
  "es",
  "esa",
  "esas",
  "ese",
  "eso",
  "esos",
  "esta",
  "estan",
  "estar",
  "estas",
  "este",
  "esto",
  "estos",
  "fue",
  "ha",
  "hay",
  "la",
  "las",
  "le",
  "les",
  "lo",
  "los",
  "mas",
  "me",
  "mi",
  "mis",
  "muy",
  "no",
  "o",
  "para",
  "pero",
  "por",
  "que",
  "se",
  "ser",
  "si",
  "sin",
  "su",
  "sus",
  "te",
  "tenemos",
  "tu",
  "tus",
  "un",
  "una",
  "unas",
  "uno",
  "unos",
  "y",
  "ya",
  // Prompt instructions and conversational context rarely identify a source passage.
  "cita",
  "citar",
  "pasaje",
  "demuestra",
  "demostrar",
  "correctamente",
  "perfil",
  "empresa",
  "cargado",
  "licitacion",
]);

function retrievalQuery(question: string) {
  const normalized = tokenize(question).join(" ");
  const concepts = new Set<string>();
  if (/\b(trayectoria|experiencia)\b/.test(normalized))
    concepts.add("experiencia trayectoria");
  if (
    /\b(constancia|constancias|certificacion|certificaciones)\b/.test(
      normalized,
    )
  )
    concepts.add("constancias certificaciones");
  if (/\b(trabajo|trabajos|anterior|anteriores)\b/.test(normalized))
    concepts.add("trabajos anteriores contratos ejecutados");
  if (
    /\b(recibido|recibidos|recibida|recibidas|correctamente)\b/.test(normalized)
  )
    concepts.add("recibido a satisfaccion");
  return [question, ...concepts].join(" ");
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Vector operation timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function lexicalRanks(chunks: EvidenceChunk[], question: string) {
  const documents = chunks.map((chunk) => tokenize(chunk.text));
  const query = new Set(
    tokenize(retrievalQuery(question)).filter(
      (term) => term.length > 2 && !SPANISH_FUNCTION_WORDS.has(term),
    ),
  );
  const documentFrequency = new Map<string, number>();
  const averageLength =
    documents.reduce((total, terms) => total + terms.length, 0) /
    Math.max(1, documents.length);
  const frequenciesByDocument = documents.map((terms) => {
    const frequencies = new Map<string, number>();
    for (const term of terms) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    for (const term of frequencies.keys())
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    return frequencies;
  });
  const ranked = chunks
    .map((chunk, index) => {
      const frequencies = frequenciesByDocument[index]!;
      const documentLength = documents[index]!.length;
      let score = 0;
      for (const term of query) {
        const tf = frequencies.get(term) ?? 0;
        if (!tf) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const lengthNorm =
          1.2 * (0.25 + (0.75 * documentLength) / Math.max(1, averageLength));
        score += idf * ((tf * 2.2) / (tf + lengthNorm));
      }
      return { chunk, index, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.map((row, index) => ({ ...row, rank: index + 1 }));
}

function splitText(text: string) {
  const pieces: string[] = [];
  const stride = PIECE_SIZE - PIECE_OVERLAP;
  for (let start = 0; start < text.length; start += stride) {
    const part = text.slice(start, start + PIECE_SIZE);
    if (part.trim()) pieces.push(part);
    if (start + PIECE_SIZE >= text.length) break;
  }
  return pieces;
}

function compareCanonicalChunks(a: EvidenceChunk, b: EvidenceChunk) {
  const left = JSON.stringify({
    documentVersionId: a.documentVersionId,
    page: a.page ?? null,
    section: a.section ?? null,
    index: a.index,
    text: a.text,
  });
  const right = JSON.stringify({
    documentVersionId: b.documentVersionId,
    page: b.page ?? null,
    section: b.section ?? null,
    index: b.index,
    text: b.text,
  });
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNotFound(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "NOT_FOUND"
  );
}

async function readCheckpoint(
  repo: DossierRepository,
  key: string,
): Promise<Checkpoint | undefined> {
  try {
    const stored = await repo.read<Checkpoint>("report", key);
    const value = stored.value;
    if (
      value?.schema === 1 &&
      typeof value.corpusHash === "string" &&
      typeof value.namespace === "string" &&
      Number.isInteger(value.nextBatch) &&
      Number.isInteger(value.totalBatches)
    )
      return value;
    return undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isRevisionConflict(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "REVISION_CONFLICT"
  );
}

async function saveCheckpoint(
  repo: DossierRepository,
  dossierId: string,
  key: string,
  checkpoint: Checkpoint,
) {
  let candidate = checkpoint;
  for (let attempt = 0; attempt < 3; attempt++) {
    const dossier = await repo.readDossier(dossierId);
    if (Number(dossier.value.corpusRevision ?? 0) !== candidate.dossierRevision)
      return;

    let stored: Awaited<ReturnType<DossierRepository["read"]>> | undefined;
    try {
      stored = await repo.read<Checkpoint>("report", key);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const current = stored?.value as Checkpoint | undefined;
    if (
      current?.corpusHash === candidate.corpusHash &&
      current.namespace === candidate.namespace &&
      current.nextBatch >= candidate.nextBatch
    )
      return;

    try {
      await repo.save("report", key, candidate, stored?.revision ?? 0);
      return;
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
    }
  }
}

function decodeEmbeddings(value: unknown, expected: number) {
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !Array.isArray(value.data)
  )
    throw new Error("Invalid embedding response");
  const rows = value.data;
  if (rows.length !== expected) throw new Error("Embedding count mismatch");
  return rows.map((row) => {
    if (
      !Array.isArray(row) ||
      row.length !== DIMENSIONS ||
      row.some((n) => typeof n !== "number" || !Number.isFinite(n))
    )
      throw new Error("Invalid embedding dimensions");
    return row as number[];
  });
}

async function embed(
  repo: DossierRepository,
  env: RetrievalEnv,
  texts: string[],
  signal: AbortSignal,
) {
  if (!env.AI) throw new Error("AI binding missing");
  await consumeOwnerLimit(repo, "embedding-daily", 1000, 86400000);
  return decodeEmbeddings(
    await env.AI.run(MODEL, { text: texts }, { signal }),
    texts.length,
  );
}

async function embeddingsForQuery(
  repo: DossierRepository,
  env: RetrievalEnv,
  question: string,
) {
  const vectors = await embed(
    repo,
    env,
    [retrievalQuery(question)],
    AbortSignal.timeout(TIMEOUT_MS),
  );
  return vectors[0];
}

async function prepareIndex(
  repo: DossierRepository,
  dossierId: string,
  chunks: EvidenceChunk[],
  env: RetrievalEnv,
  heartbeat?: () => Promise<void>,
) {
  const allCanonical = chunks
    .map((chunk) => ({
      documentVersionId: chunk.documentVersionId,
      page: chunk.page ?? null,
      section: chunk.section ?? null,
      index: chunk.index,
      text: chunk.text,
    }))
    .sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const corpusHash = await sha256(JSON.stringify(allCanonical));
  const ownerId = repo.context.ownerId;
  const namespace = await sha256(
    JSON.stringify([ownerId, dossierId, corpusHash]),
  );
  const ownerScope = await sha256(JSON.stringify([ownerId]));
  const tenderScope = await sha256(JSON.stringify([ownerId, dossierId]));
  const generation = corpusHash;
  const dossier = await repo.readDossier(dossierId);
  const dossierRevision = Number(dossier.value.corpusRevision ?? 0);
  const indexedChunks = chunks.slice(0, MAX_SOURCE_CHUNKS);
  const limited = chunks.length > MAX_SOURCE_CHUNKS;
  const pieces: Piece[] = [];
  for (let i = 0; i < indexedChunks.length; i++) {
    const source = indexedChunks[i]!;
    const sourceHash = await sha256(
      JSON.stringify({
        documentVersionId: source.documentVersionId,
        page: source.page ?? null,
        section: source.section ?? null,
        index: source.index,
        text: source.text,
      }),
    );
    for (const [part, text] of splitText(source.text).entries()) {
      const id = await sha256(`${namespace}\n${sourceHash}\n${part}`);
      pieces.push({
        id,
        sourceRef: sourceHash,
        text,
        chunkIndex: i,
        part,
        metadata: {
          ownerScope,
          tenderScope,
          generation,
          sourceRef: sourceHash,
        },
      });
    }
  }
  const checkpointId = await sha256(`retrieval\n${ownerId}\n${dossierId}`);
  const checkpoint = await readCheckpoint(repo, checkpointId);
  const batches: Piece[][] = [];
  for (let i = 0; i < pieces.length; i += BATCH_SIZE)
    batches.push(pieces.slice(i, i + BATCH_SIZE));
  let nextBatch =
    checkpoint?.corpusHash === corpusHash &&
    checkpoint.namespace === namespace &&
    checkpoint.totalBatches === batches.length
      ? Math.min(checkpoint.nextBatch, batches.length)
      : 0;
  const startBatch = nextBatch;
  const stopBatch = Math.min(batches.length, startBatch + MAX_BATCHES_PER_CALL);
  let indexFailure: "index_pending" | "embedding_failed" | undefined;
  let lastMutationId =
    checkpoint?.corpusHash === corpusHash && checkpoint.namespace === namespace
      ? checkpoint.lastMutationId
      : undefined;

  for (; nextBatch < stopBatch; nextBatch++) {
    await heartbeat?.();
    const batch = batches[nextBatch]!;
    try {
      const values = await embed(
        repo,
        env,
        batch.map((piece) => piece.text),
        AbortSignal.timeout(TIMEOUT_MS),
      );
      const upsertResult = await withTimeout(() =>
        env.DOSSIER_VECTORS!.upsert(
          batch.map((piece, index) => ({
            id: piece.id,
            values: values[index]!,
            namespace,
            metadata: piece.metadata,
          })),
        ),
      );
      if (
        !upsertResult ||
        typeof upsertResult !== "object" ||
        !("mutationId" in upsertResult) ||
        typeof upsertResult.mutationId !== "string"
      )
        throw new Error("Vector upsert did not return a mutation ID");
      lastMutationId = upsertResult.mutationId;
    } catch (error) {
      if (
        (error instanceof DossierError && error.code === "OWNER_RATE_LIMIT") ||
        (error instanceof Error &&
          /embedding|dimension|count|AI binding/i.test(error.message))
      )
        indexFailure = "embedding_failed";
      else indexFailure = "index_pending";
      break;
    }
    const acceptedBatch = nextBatch + 1;
    const newCheckpoint: Checkpoint = {
      schema: 1,
      corpusHash,
      namespace,
      nextBatch: acceptedBatch,
      totalBatches: batches.length,
      ...(lastMutationId ? { lastMutationId } : {}),
      dossierRevision,
    };
    await saveCheckpoint(repo, dossierId, checkpointId, newCheckpoint);
    await heartbeat?.();
  }
  return {
    namespace,
    ownerScope,
    tenderScope,
    generation,
    pieces,
    indexedChunks,
    limited,
    nextBatch,
    totalBatches: batches.length,
    indexFailure,
    checkpointId,
    corpusHash,
    startBatch,
    lastMutationId,
    async visibilityConfirmed() {
      if (!lastMutationId) return false;
      if (env.DOSSIER_VECTORS?.describe) {
        try {
          const description = await withTimeout(() =>
            env.DOSSIER_VECTORS!.describe!(),
          );
          if (description.processedUpToMutation === lastMutationId) return true;
        } catch {
          // getByIds below is the authoritative fallback when another mutation advanced the cursor.
        }
      }
      const getByIds = env.DOSSIER_VECTORS?.getByIds;
      const submittedCount = Math.min(nextBatch * BATCH_SIZE, pieces.length);
      if (!getByIds || submittedCount === 0 || submittedCount > 1000)
        return false;
      for (let start = 0; start < submittedCount; start += 128) {
        const batch = pieces.slice(
          start,
          Math.min(start + 128, submittedCount),
        );
        await heartbeat?.();
        let returned: Awaited<
          ReturnType<NonNullable<DossierVectorIndex["getByIds"]>>
        >;
        try {
          returned = await withTimeout(() =>
            env.DOSSIER_VECTORS!.getByIds!(batch.map((piece) => piece.id)),
          );
        } catch {
          await heartbeat?.();
          return false;
        }
        await heartbeat?.();
        if (!Array.isArray(returned)) return false;
        const byId = new Map(returned.map((vector) => [vector.id, vector]));
        for (const piece of batch) {
          const vector = byId.get(piece.id);
          const metadata = vector?.metadata;
          if (
            !vector ||
            vector.namespace !== namespace ||
            !metadata ||
            metadata.ownerScope !== ownerScope ||
            metadata.tenderScope !== tenderScope ||
            metadata.generation !== generation ||
            metadata.sourceRef !== piece.sourceRef
          )
            return false;
        }
      }
      return true;
    },
  };
}

function mergeRanks(
  chunks: EvidenceChunk[],
  lexical: ReturnType<typeof lexicalRanks>,
  semanticIndices: number[],
) {
  const scores = new Map<number, number>();
  const rrf = (rank: number) => 1 / (60 + rank);
  lexical.forEach((row) =>
    scores.set(row.index, (scores.get(row.index) ?? 0) + rrf(row.rank)),
  );
  semanticIndices.forEach((index, rank) =>
    scores.set(index, (scores.get(index) ?? 0) + rrf(rank + 1)),
  );
  const selected = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([index]) => index);
  const positionsBySource = new Map<string, Map<number, number>>();
  chunks.forEach((chunk, position) => {
    const positions =
      positionsBySource.get(chunk.documentVersionId) ?? new Map();
    positions.set(chunk.index, position);
    positionsBySource.set(chunk.documentVersionId, positions);
  });
  const output: EvidenceChunk[] = [];
  const added = new Set<number>();
  const add = (index: number) => {
    if (
      index < 0 ||
      index >= chunks.length ||
      added.has(index) ||
      output.length >= MAX_EVIDENCE
    )
      return;
    added.add(index);
    output.push(chunks[index]!);
  };
  // Keep direct ranked results intact. Neighbor context is useful, but it must
  // never push a stronger lexical or semantic hit out of the evidence budget.
  for (const index of selected) add(index);
  for (const index of selected) {
    const source = chunks[index]!;
    const positions = positionsBySource.get(source.documentVersionId);
    add(positions?.get(source.index - 1) ?? -1);
    add(positions?.get(source.index + 1) ?? -1);
  }
  return output;
}

export async function retrieveTenderEvidence(
  repo: DossierRepository,
  dossierId: string,
  chunks: EvidenceChunk[],
  question: string,
  env: RetrievalEnv,
  heartbeat?: () => Promise<void>,
): Promise<{ evidence: EvidenceChunk[]; retrieval: TenderRetrieval }> {
  const canonicalChunks = [...chunks].sort(compareCanonicalChunks);
  const lexicalChunks = canonicalChunks.slice(0, MAX_SOURCE_CHUNKS);
  const sourceChunksScanned = lexicalChunks.length;
  const sourceChunksTotal = canonicalChunks.length;
  const sourceLimited = sourceChunksTotal > MAX_SOURCE_CHUNKS;
  const lexical = lexicalRanks(lexicalChunks, question);
  if (!env.AI || !env.DOSSIER_VECTORS) {
    return {
      evidence: lexical.slice(0, MAX_EVIDENCE).map((row) => row.chunk),
      retrieval: {
        mode: "lexical",
        reason: "vector_binding_missing",
        indexedPieces: 0,
        totalPieces: 0,
        sourceChunksScanned,
        sourceChunksTotal,
        semanticMatches: 0,
        indexingSubmitted: false,
        visibilityConfirmed: false,
        complete: false,
        partial: sourceLimited,
      },
    };
  }
  const index = await prepareIndex(
    repo,
    dossierId,
    canonicalChunks,
    env,
    heartbeat,
  );
  if (index.indexFailure) {
    return {
      evidence: lexical.slice(0, MAX_EVIDENCE).map((row) => row.chunk),
      retrieval: {
        mode: "lexical",
        reason: index.indexFailure,
        indexedPieces: index.pieces.slice(0, index.nextBatch * BATCH_SIZE)
          .length,
        totalPieces: index.pieces.length,
        sourceChunksScanned,
        sourceChunksTotal,
        namespace: index.namespace,
        semanticMatches: 0,
        indexingSubmitted: index.nextBatch > 0,
        visibilityConfirmed: false,
        complete: false,
        partial: true,
      },
    };
  }
  if (index.nextBatch < index.totalBatches) {
    // A conversation turn advances only a bounded number of indexing batches.
    // Search is still useful, but the returned coverage remains explicitly partial.
  }
  await heartbeat?.();
  let queryVector: number[];
  try {
    queryVector = await embeddingsForQuery(repo, env, question);
  } catch {
    return {
      evidence: lexical.slice(0, MAX_EVIDENCE).map((row) => row.chunk),
      retrieval: {
        mode: "lexical",
        reason: "embedding_failed",
        indexedPieces:
          index.nextBatch >= index.totalBatches
            ? index.pieces.length
            : index.nextBatch * BATCH_SIZE,
        totalPieces: index.pieces.length,
        sourceChunksScanned,
        sourceChunksTotal,
        namespace: index.namespace,
        semanticMatches: 0,
        indexingSubmitted: index.nextBatch > 0,
        visibilityConfirmed: false,
        complete: false,
        partial: true,
      },
    };
  }
  let matches: NonNullable<
    Awaited<ReturnType<DossierVectorIndex["query"]>>["matches"]
  >;
  try {
    const response = await withTimeout(() =>
      env.DOSSIER_VECTORS!.query(queryVector, {
        namespace: index.namespace,
        topK: QUERY_LIMIT,
        filter: {
          ownerScope: index.ownerScope,
          tenderScope: index.tenderScope,
          generation: index.generation,
        },
        returnMetadata: "all",
      }),
    );
    matches = Array.isArray(response.matches) ? response.matches : [];
  } catch {
    return {
      evidence: lexical.slice(0, MAX_EVIDENCE).map((row) => row.chunk),
      retrieval: {
        mode: "lexical",
        reason: "vector_search_failed",
        indexedPieces:
          index.nextBatch >= index.totalBatches
            ? index.pieces.length
            : index.nextBatch * BATCH_SIZE,
        totalPieces: index.pieces.length,
        sourceChunksScanned,
        sourceChunksTotal,
        namespace: index.namespace,
        semanticMatches: 0,
        indexingSubmitted: index.nextBatch > 0,
        visibilityConfirmed: false,
        complete: false,
        partial: true,
      },
    };
  }

  const currentChunks = new Map(
    index.indexedChunks.map((chunk, position) => [position, chunk]),
  );
  const acceptedPieceCount = Math.min(
    index.nextBatch * BATCH_SIZE,
    index.pieces.length,
  );
  const currentIds = new Map(
    index.pieces.slice(0, acceptedPieceCount).map((piece) => [piece.id, piece]),
  );
  const semanticIndices: number[] = [];
  const semanticSeen = new Set<number>();
  for (const match of matches) {
    const piece = currentIds.get(match.id);
    const metadata = match.metadata;
    if (
      !piece ||
      match.namespace !== index.namespace ||
      !metadata ||
      metadata.ownerScope !== index.ownerScope ||
      metadata.tenderScope !== index.tenderScope ||
      metadata.generation !== index.generation ||
      metadata.sourceRef !== piece.sourceRef ||
      !currentChunks.has(piece.chunkIndex)
    )
      continue;
    if (!semanticSeen.has(piece.chunkIndex)) {
      semanticSeen.add(piece.chunkIndex);
      semanticIndices.push(piece.chunkIndex);
    }
  }
  const evidence = mergeRanks(
    index.indexedChunks,
    lexical.filter((row) => row.index < index.indexedChunks.length),
    semanticIndices,
  );
  const visibilityConfirmed = await index.visibilityConfirmed();
  const complete =
    index.nextBatch >= index.totalBatches &&
    !index.limited &&
    semanticIndices.length > 0 &&
    visibilityConfirmed;
  const reason =
    index.nextBatch < index.totalBatches ||
    index.limited ||
    !visibilityConfirmed
      ? "index_pending"
      : !semanticIndices.length
        ? "no_vector_matches"
        : undefined;
  return {
    evidence,
    retrieval: {
      mode: semanticIndices.length ? "hybrid" : "lexical",
      ...(reason ? { reason } : {}),
      namespace: index.namespace,
      semanticMatches: semanticIndices.length,
      indexedPieces:
        index.nextBatch >= index.totalBatches
          ? index.pieces.length
          : Math.min(index.nextBatch * BATCH_SIZE, index.pieces.length),
      totalPieces: index.pieces.length,
      sourceChunksScanned,
      sourceChunksTotal,
      complete,
      partial: !complete,
      indexingSubmitted: index.nextBatch > 0,
      visibilityConfirmed,
    },
  };
}
