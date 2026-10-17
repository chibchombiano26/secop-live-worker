import { describe, expect, it } from "vitest";
import type { EvidenceChunk } from "../src/dossier/extraction";
import type { DossierRepository } from "../src/dossier/repository";
import { sha256 } from "../src/dossier/downloads";
import { retrieveTenderEvidence } from "../src/dossier/retrieval";

type Vector = {
  id: string;
  values: number[];
  namespace: string;
  metadata: Record<string, string>;
};

class MemoryVectors {
  namespaces = new Map<string, Map<string, Vector>>();
  upserts = 0;
  queryResult?: {
    matches: Array<{
      id: string;
      namespace?: string;
      metadata?: Record<string, unknown>;
      score?: number;
    }>;
  };
  queryOptions?: {
    namespace: string;
    topK: number;
    filter: Record<string, unknown>;
    returnMetadata: "all";
  };
  failUpsert = false;
  processedUpToMutation = "not-yet-visible";
  getByIdsVisible = false;
  semanticSourceRefs?: string[];

  async upsert(vectors: Vector[]) {
    this.upserts++;
    if (this.failUpsert) throw new Error("write unavailable");
    for (const vector of vectors) {
      const namespace = this.namespaces.get(vector.namespace) ?? new Map();
      namespace.set(vector.id, vector);
      this.namespaces.set(vector.namespace, namespace);
    }
    return { mutationId: `mutation-${this.upserts}` };
  }

  async describe() {
    return { processedUpToMutation: this.processedUpToMutation };
  }

  async getByIds(ids: string[]) {
    if (!this.getByIdsVisible) return [];
    const found: Vector[] = [];
    for (const rows of this.namespaces.values()) {
      for (const id of ids) {
        const vector = rows.get(id);
        if (vector) found.push(vector);
      }
    }
    return found;
  }

  async query(
    _vector: number[],
    input: {
      namespace: string;
      topK: number;
      filter: Record<string, unknown>;
      returnMetadata: "all";
    },
  ) {
    this.queryOptions = input;
    if (this.queryResult) return this.queryResult;
    const namespace = this.namespaces.get(input.namespace);
    if (!namespace) return { matches: [] };
    const [key, value] = Object.entries(input.filter)[0] ?? [];
    const matches = [...namespace.values()]
      .filter((v) => v.metadata[key] === value)
      .sort((a, b) => {
        if (!this.semanticSourceRefs) return 0;
        return (
          this.semanticSourceRefs.indexOf(a.metadata.sourceRef) -
          this.semanticSourceRefs.indexOf(b.metadata.sourceRef)
        );
      })
      .slice(0, input.topK)
      .map((v) => ({
        id: v.id,
        namespace: v.namespace,
        metadata: v.metadata,
        score: 1,
      }));
    return { matches };
  }
}

class MemoryRepo {
  context = { ownerId: "owner-a" };
  records = new Map<string, unknown>();
  embeddingBudgetExceeded = false;
  conflictNextCheckpointAt?: number;
  advanceCheckpointOnRead?: {
    id: string;
    value: unknown;
    occurrence: number;
  };
  reportReads = 0;
  revisions = new Map<string, number>();
  db = {
    prepare: (_sql: string) => ({
      bind: (..._values: unknown[]) => ({
        first: async () =>
          this.embeddingBudgetExceeded ? undefined : { count: 1 },
      }),
    }),
  };
  now = () => Date.now();
  async read(_kind: string, id: string) {
    if (_kind === "report") {
      this.reportReads++;
      if (
        this.advanceCheckpointOnRead &&
        this.reportReads === this.advanceCheckpointOnRead.occurrence
      ) {
        this.records.set(
          this.advanceCheckpointOnRead.id,
          this.advanceCheckpointOnRead.value,
        );
        this.revisions.set(this.advanceCheckpointOnRead.id, 1);
        this.advanceCheckpointOnRead = undefined;
      }
    }
    const value = this.records.get(id);
    if (value === undefined)
      throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
    return { id, revision: this.revisions.get(id) ?? 1, value, updatedAt: 0 };
  }
  async readDossier(id: string) {
    return { id, revision: 1, value: { corpusRevision: 1 }, updatedAt: 0 };
  }
  async save(
    _kind: string,
    id: string,
    value: unknown,
    expectedRevision: number,
  ) {
    if (
      _kind === "report" &&
      this.conflictNextCheckpointAt !== undefined &&
      value &&
      typeof value === "object" &&
      "nextBatch" in value
    ) {
      this.records.set(id, {
        ...value,
        nextBatch: this.conflictNextCheckpointAt,
        lastMutationId: "mutation-from-concurrent-chat",
      });
      this.revisions.set(id, 1);
      this.conflictNextCheckpointAt = undefined;
      throw Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" });
    }
    const revision = this.revisions.get(id) ?? 0;
    if (revision !== expectedRevision)
      throw Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" });
    this.records.set(id, value);
    this.revisions.set(id, revision + 1);
    return { id, revision: revision + 1, value, updatedAt: 0 };
  }
  async upsert(_kind: string, id: string, value: unknown) {
    if (
      _kind === "report" &&
      this.conflictNextCheckpointAt !== undefined &&
      value &&
      typeof value === "object" &&
      "nextBatch" in value
    ) {
      this.records.set(id, {
        ...value,
        nextBatch: this.conflictNextCheckpointAt,
        lastMutationId: "mutation-from-concurrent-chat",
      });
      this.conflictNextCheckpointAt = undefined;
      throw Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" });
    }
    this.records.set(id, value);
    return { id, revision: 1, value, updatedAt: 0 };
  }
}

function chunk(id: string, text: string, index: number): EvidenceChunk {
  return { documentVersionId: id, index, page: index + 1, text };
}

function envWith(
  vectors: MemoryVectors,
  embed: (texts: string[]) => Promise<unknown> = async (texts: string[]) => ({
    data: texts.map(() =>
      Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
    ),
  }),
) {
  return {
    DOSSIER_VECTORS: vectors,
    AI: {
      run: async (_model: string, input: { text: string[] }) =>
        embed(input.text),
    },
  };
}

describe("retrieveTenderEvidence", () => {
  it("uses only vector matches validated against the current owner's dossier corpus", async () => {
    const vectors = new MemoryVectors();
    vectors.queryResult = {
      matches: [
        {
          id: "foreign-id",
          namespace: "foreign",
          metadata: {
            ownerScope: "foreign",
            tenderScope: "foreign",
            generation: "foreign",
          },
        },
        {
          id: "missing-id",
          namespace: "foreign",
          metadata: { ownerScope: "x", tenderScope: "x", generation: "x" },
        },
        {
          id: "fake-id",
          namespace: "foreign",
          metadata: { ownerScope: "x", tenderScope: "x", generation: "x" },
          score: 1,
        },
      ],
    };
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.12",
      [chunk("v1", "El plazo de entrega es de veinte días hábiles.", 0)],
      "plazo entrega",
      envWith(vectors),
    );
    expect(
      result.evidence.every(
        (item) =>
          item.text === "El plazo de entrega es de veinte días hábiles.",
      ),
    ).toBe(true);
    expect(result.retrieval).toMatchObject({ mode: "lexical" });
  });

  it("keeps valid canonical evidence while rejecting adjacent foreign and forged matches", async () => {
    const vectors = new MemoryVectors();
    const originalQuery = vectors.query.bind(vectors);
    vectors.query = async (queryVector, options) => {
      const response = await originalQuery(queryVector, options);
      const canonical = response.matches?.[0];
      if (!canonical) return response;
      return {
        matches: [
          {
            ...canonical,
            metadata: { ...canonical.metadata, tenderScope: "foreign" },
          },
          { ...canonical, id: "foreign-source" },
          canonical,
        ],
      };
    };
    const expected = chunk(
      "rag-current",
      "El personal debe presentar títulos universitarios en ingeniería.",
      0,
    );
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.129",
      [expected, chunk("rag-other", "Licencia de aviación para Tender B.", 0)],
      "¿Qué acreditaciones profesionales necesitamos?",
      envWith(vectors),
    );
    expect(result.evidence).toContainEqual(expected);
    expect(result.retrieval).toMatchObject({
      mode: "hybrid",
      semanticMatches: 1,
    });
  });

  it("uses scoped BGE vectors to retrieve a semantic synonym and fuses it with lexical ranking", async () => {
    const vectors = new MemoryVectors();
    const synonym = chunk(
      "v1",
      "El contratista debe constituir una garantía bancaria de cumplimiento.",
      0,
    );
    const literal = chunk(
      "v1",
      "La entidad publicará el cronograma de la licitación.",
      1,
    );
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.13",
      [synonym, literal],
      "¿Qué respaldo financiero protege la ejecución del contrato?",
      envWith(vectors),
    );
    expect(result.evidence[0]).toEqual(synonym);
    expect(result.retrieval).toMatchObject({ mode: "hybrid" });
    const stored = [...vectors.namespaces.values()][0];
    expect(stored?.size).toBeGreaterThan(0);
    for (const vector of stored!.values()) {
      expect(vector.values).toHaveLength(1024);
      expect(vector.namespace).toBeTruthy();
      expect(Object.values(vector.metadata).every((v) => v.length <= 64)).toBe(
        true,
      );
    }
    expect(vectors.queryOptions?.returnMetadata).toBe("all");
    expect(vectors.queryOptions?.namespace).toBe(
      [...vectors.namespaces.keys()][0],
    );
  });

  it("keeps retrieval partial until Vectorize processes the checkpointed mutation", async () => {
    const vectors = new MemoryVectors();
    const repo = new MemoryRepo() as unknown as DossierRepository;
    const items = [chunk("v1", "La garantía bancaria protege el contrato.", 0)];
    const binding = envWith(vectors);
    const pending = await retrieveTenderEvidence(
      repo,
      "CO1.REQ.132",
      items,
      "respaldo financiero",
      binding,
    );
    expect(pending.retrieval).toMatchObject({
      complete: false,
      partial: true,
      visibilityConfirmed: false,
      reason: "index_pending",
    });
    vectors.processedUpToMutation = "mutation-1";
    vectors.getByIdsVisible = true;
    const visible = await retrieveTenderEvidence(
      repo,
      "CO1.REQ.132",
      items,
      "respaldo financiero",
      binding,
    );
    expect(visible.retrieval).toMatchObject({
      complete: true,
      partial: false,
      visibilityConfirmed: true,
      semanticMatches: 1,
    });
    expect(vectors.upserts).toBe(1);
  });

  it("confirms all local vectors even when a later unrelated mutation replaced the processed cursor", async () => {
    const vectors = new MemoryVectors();
    const repo = new MemoryRepo() as unknown as DossierRepository;
    const items = [chunk("v1", "La garantía bancaria protege el contrato.", 0)];
    await retrieveTenderEvidence(
      repo,
      "CO1.REQ.1321",
      items,
      "respaldo financiero",
      envWith(vectors),
    );
    vectors.processedUpToMutation = "mutation-from-another-owner";
    vectors.getByIdsVisible = true;
    const visible = await retrieveTenderEvidence(
      repo,
      "CO1.REQ.1321",
      items,
      "respaldo financiero",
      envWith(vectors),
    );
    expect(visible.retrieval).toMatchObject({
      complete: true,
      visibilityConfirmed: true,
    });
  });

  it("propagates lease loss during bounded getByIds visibility checks", async () => {
    const vectors = new MemoryVectors();
    vectors.getByIdsVisible = true;
    let heartbeatCount = 0;
    await expect(
      retrieveTenderEvidence(
        new MemoryRepo() as unknown as DossierRepository,
        "CO1.REQ.13211",
        [chunk("v1", "La garantía bancaria protege el contrato.", 0)],
        "respaldo financiero",
        envWith(vectors),
        async () => {
          heartbeatCount++;
          if (heartbeatCount === 4) throw new Error("lease lost");
        },
      ),
    ).rejects.toThrow("lease lost");
  });

  it("tolerates a same-corpus checkpoint revision conflict from another chat", async () => {
    const vectors = new MemoryVectors();
    const repo = new MemoryRepo();
    repo.conflictNextCheckpointAt = 2;
    const result = await retrieveTenderEvidence(
      repo as unknown as DossierRepository,
      "CO1.REQ.1322",
      [chunk("v1", "La garantía bancaria protege el contrato.", 0)],
      "respaldo financiero",
      envWith(vectors),
    );
    expect(result.retrieval.mode).toBe("hybrid");
    const checkpoint = [...repo.records.values()].find(
      (value) => !!value && typeof value === "object" && "schema" in value,
    ) as unknown as { nextBatch: number };
    expect(checkpoint.nextBatch).toBe(2);
  });

  it("does not overwrite a same-generation checkpoint that advanced before save", async () => {
    const vectors = new MemoryVectors();
    const repo = new MemoryRepo();
    const dossierId = "CO1.REQ.1323";
    const source = chunk("v1", "La garantía bancaria protege el contrato.", 0);
    const corpusHash = await sha256(
      JSON.stringify([
        {
          documentVersionId: source.documentVersionId,
          page: source.page ?? null,
          section: source.section ?? null,
          index: source.index,
          text: source.text,
        },
      ]),
    );
    const namespace = await sha256(
      JSON.stringify([repo.context.ownerId, dossierId, corpusHash]),
    );
    const checkpointId = await sha256(
      `retrieval\n${repo.context.ownerId}\n${dossierId}`,
    );
    repo.advanceCheckpointOnRead = {
      id: checkpointId,
      occurrence: 2,
      value: {
        schema: 1,
        corpusHash,
        namespace,
        nextBatch: 4,
        totalBatches: 1,
        lastMutationId: "mutation-from-faster-chat",
        dossierRevision: 1,
      },
    };
    await retrieveTenderEvidence(
      repo as unknown as DossierRepository,
      dossierId,
      [source],
      "respaldo financiero",
      envWith(vectors),
    );
    expect(repo.records.get(checkpointId)).toMatchObject({
      nextBatch: 4,
      lastMutationId: "mutation-from-faster-chat",
    });
  });

  it("rejects vector results with a missing or mismatched returned namespace", async () => {
    for (const returnedNamespace of [undefined, "another-namespace"]) {
      const vectors = new MemoryVectors();
      const originalQuery = vectors.query.bind(vectors);
      vectors.query = async (queryVector, options) => {
        const result = await originalQuery(queryVector, options);
        return {
          matches: result.matches?.map((match) => ({
            ...match,
            namespace: returnedNamespace,
          })),
        };
      };
      const result = await retrieveTenderEvidence(
        new MemoryRepo() as unknown as DossierRepository,
        "CO1.REQ.131",
        [chunk("v1", "La garantía bancaria protege el contrato.", 0)],
        "respaldo financiero",
        envWith(vectors),
      );
      expect(result.retrieval.mode).toBe("lexical");
      expect(result.retrieval.semanticMatches).toBe(0);
    }
  });

  it("changes the vector namespace when the canonical corpus changes", async () => {
    const vectors = new MemoryVectors();
    const repo = new MemoryRepo() as unknown as DossierRepository;
    const binding = envWith(vectors);
    await retrieveTenderEvidence(
      repo,
      "CO1.REQ.14",
      [chunk("v1", "Texto original de referencia.", 0)],
      "referencia",
      binding,
    );
    await retrieveTenderEvidence(
      repo,
      "CO1.REQ.14",
      [chunk("v1", "Texto revisado de referencia.", 0)],
      "referencia",
      binding,
    );
    expect(vectors.namespaces.size).toBe(2);
  });

  it("splits long source chunks into overlapping BGE-sized pieces", async () => {
    const vectors = new MemoryVectors();
    const text = "A".repeat(2500);
    await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.141",
      [chunk("v1", text, 0)],
      "A",
      envWith(vectors),
    );
    const indexed = [...vectors.namespaces.values()][0]!;
    expect(indexed.size).toBe(2);
  });

  it("uses lexical fallback when indexing is pending after a rejected vector write", async () => {
    const vectors = new MemoryVectors();
    vectors.failUpsert = true;
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.15",
      [chunk("v1", "La experiencia mínima requerida es de cinco años.", 0)],
      "experiencia mínima",
      envWith(vectors),
    );
    expect(result.evidence).toHaveLength(1);
    expect(result.retrieval).toMatchObject({
      mode: "lexical",
      reason: "index_pending",
    });
  });

  it("rejects incomplete or malformed embedding responses and reports lexical fallback", async () => {
    const vectors = new MemoryVectors();
    const badEnv = envWith(vectors, async () => ({ data: [[1, 2, 3]] }));
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.151",
      [chunk("v1", "La experiencia mínima requerida es de cinco años.", 0)],
      "experiencia mínima",
      badEnv,
    );
    expect(result.evidence).toHaveLength(1);
    expect(result.retrieval).toMatchObject({
      mode: "lexical",
      reason: "embedding_failed",
      complete: false,
    });
    expect(vectors.upserts).toBe(0);
  });

  it("falls back explicitly when the owner's daily embedding budget is exhausted", async () => {
    const vectors = new MemoryVectors();
    const repo = new MemoryRepo();
    repo.embeddingBudgetExceeded = true;
    const result = await retrieveTenderEvidence(
      repo as unknown as DossierRepository,
      "CO1.REQ.152",
      [chunk("v1", "La experiencia mínima requerida es de cinco años.", 0)],
      "experiencia mínima",
      envWith(vectors),
    );
    expect(result.evidence).toHaveLength(1);
    expect(result.retrieval).toMatchObject({
      mode: "lexical",
      reason: "embedding_failed",
      complete: false,
    });
    expect(vectors.upserts).toBe(0);
  });

  it("falls back when vector search fails and does not retry without filters", async () => {
    const vectors = new MemoryVectors();
    vectors.query = async () => {
      throw new Error("query unavailable");
    };
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.16",
      [chunk("v1", "La oferta económica debe incluir impuestos.", 0)],
      "oferta económica",
      envWith(vectors),
    );
    expect(result.retrieval).toMatchObject({
      mode: "lexical",
      reason: "vector_search_failed",
    });
  });

  it("resumes accepted batches from the saved checkpoint without repeating writes", async () => {
    const vectors = new MemoryVectors();
    const repo = new MemoryRepo() as unknown as DossierRepository;
    const items = Array.from({ length: 17 }, (_, i) =>
      chunk("v1", `Requisito de referencia ${i}.`, i),
    );
    let breakHeartbeat = true;
    await expect(
      retrieveTenderEvidence(
        repo,
        "CO1.REQ.17",
        items,
        "referencia",
        envWith(vectors),
        async () => {
          if (breakHeartbeat) {
            breakHeartbeat = false;
            throw new Error("lease lost");
          }
        },
      ),
    ).rejects.toThrow("lease lost");
    expect(vectors.upserts).toBe(0);
    let calls = 0;
    await retrieveTenderEvidence(
      repo,
      "CO1.REQ.17",
      items,
      "referencia",
      envWith(vectors),
      async () => {
        calls++;
      },
    );
    expect(vectors.upserts).toBe(2);
    expect(calls).toBe(7); // write and getByIds batches each keep the chat lease alive
    const before = vectors.upserts;
    await retrieveTenderEvidence(
      repo,
      "CO1.REQ.17",
      items,
      "referencia",
      envWith(vectors),
    );
    expect(vectors.upserts).toBe(before);
  });

  it("resumes the same canonical corpus when repository chunk order changes", async () => {
    const vectors = new MemoryVectors();
    const repo = new MemoryRepo() as unknown as DossierRepository;
    const items = Array.from({ length: 65 }, (_, i) =>
      chunk("v1", `requisito-${i}-` + "x".repeat(100), i),
    );
    const binding = envWith(vectors);
    await retrieveTenderEvidence(
      repo,
      "CO1.REQ.171",
      items,
      "requisito",
      binding,
    );
    expect(vectors.upserts).toBe(4);
    await retrieveTenderEvidence(
      repo,
      "CO1.REQ.171",
      [...items].reverse(),
      "requisito",
      binding,
    );
    expect(vectors.upserts).toBe(5);
    expect([...vectors.namespaces.values()][0]?.size).toBe(65);
  });

  it("drops lexical zero matches and exposes missing vector bindings", async () => {
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.18",
      [chunk("v1", "El documento describe las condiciones de pago.", 0)],
      "¿Cómo se acredita experiencia?",
      {},
    );
    expect(result.evidence).toEqual([]);
    expect(result.retrieval).toMatchObject({
      mode: "lexical",
      reason: "vector_binding_missing",
    });
  });

  it("adds only bounded adjacent chunks to a selected page", async () => {
    const vectors = new MemoryVectors();
    const items = Array.from({ length: 20 }, (_, i) =>
      chunk("v1", `parte${i} documento largo`, i),
    );
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.19",
      items,
      "parte9",
      envWith(vectors),
    );
    expect(result.evidence.length).toBeLessThanOrEqual(10);
    expect(result.evidence.map((c) => c.index)).toContain(9);
  });

  it("adds source chunk 10 as the actual neighbor of source chunk 9", async () => {
    const vectors = new MemoryVectors();
    vectors.queryResult = { matches: [] };
    const items = Array.from({ length: 12 }, (_, i) => ({
      documentVersionId: "v1",
      index: i,
      text: i === 9 ? "target source chunk" : `content for source chunk ${i}`,
    }));
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.191",
      items,
      "target",
      envWith(vectors),
    );
    expect(result.evidence.map((item) => item.index)).toEqual(
      expect.arrayContaining([9, 10]),
    );
  });

  it("keeps the minimum-experience and satisfactory-receipt passages under live SECOP vector ranks", async () => {
    const vectors = new MemoryVectors();
    const embeddedTexts: string[] = [];
    const question =
      "¿Con cuántas constancias de trabajos anteriores se acredita la trayectoria del oferente en esta licitación? Cita el pasaje que fija la cantidad y cómo se demuestra que esos trabajos fueron recibidos correctamente. No tenemos perfil de empresa cargado.";
    const studiesP3: EvidenceChunk = {
      documentVersionId: "public-studies",
      page: 3,
      index: 2,
      text: "EXPERIENCIA DEL PROPONENTE. El proponente deberá acreditar experiencia para entidades públicas o privadas, anexando mínimo dos (2) certificaciones y/o facturas o",
    };
    const studiesP4: EvidenceChunk = {
      documentVersionId: "public-studies",
      page: 4,
      index: 3,
      text: "contratos ejecutados que lo respalden, dichas certificaciones deben manifestar el respectivo recibido a satisfacción.",
    };
    const distractions: EvidenceChunk[] = Array.from(
      { length: 13 },
      (_, i) => ({
        documentVersionId: `public-notice-${i}`,
        page: i + 1,
        index: 0,
        text: `El proponente deberá presentar los documentos requeridos para la oferta del proceso y cumplir las condiciones establecidas por la entidad. ${i % 2 ? "La invitación pública fija los requisitos habilitantes." : "Se publicará el cronograma de la licitación."}`,
      }),
    );
    const corpus = [studiesP3, studiesP4, ...distractions];
    const sourceRefs = await Promise.all(
      corpus.map((item) =>
        sha256(
          JSON.stringify({
            documentVersionId: item.documentVersionId,
            page: item.page ?? null,
            section: item.section ?? null,
            index: item.index,
            text: item.text,
          }),
        ),
      ),
    );
    // Captured semantic order: invitation/supervisor distractors rank first;
    // studies page 4 is semantic rank 11 and page 3 rank 15.
    vectors.semanticSourceRefs = [
      ...distractions.slice(0, 10).map((_, i) => sourceRefs[i + 2]!),
      sourceRefs[1]!,
      ...distractions.slice(10).map((_, i) => sourceRefs[i + 12]!),
      sourceRefs[0]!,
    ];
    const result = await retrieveTenderEvidence(
      new MemoryRepo() as unknown as DossierRepository,
      "CO1.REQ.1901",
      corpus,
      question,
      envWith(vectors, async (texts) => {
        embeddedTexts.push(...texts);
        return {
          data: texts.map(() =>
            Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
          ),
        };
      }),
    );
    expect(result.evidence).toContainEqual(studiesP3);
    expect(result.evidence).toContainEqual(studiesP4);
    expect(embeddedTexts.at(-1)).toContain("experiencia trayectoria");
    expect(embeddedTexts.at(-1)).toContain("constancias certificaciones");
    expect(embeddedTexts.at(-1)).toContain("contratos ejecutados");
    expect(embeddedTexts.at(-1)).toContain("recibido a satisfaccion");
  });
});
