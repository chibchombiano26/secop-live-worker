import { z } from "zod/v4";
import { DossierError } from "./contracts";
import type { EvidenceChunk } from "./extraction";
import type { ModelInput, ModelProvider } from "./model";
import { validateCitations, type Citation } from "./synthesis";

const INPUT_LIMIT = 48000;
const BLOCK_LIMIT = 36000;
const responseSchema = z.object({
  answer: z.string().min(1).max(18000),
  insufficientEvidence: z.boolean(),
  citations: z.array(z.object({
    sourceRef: z.string(),
    excerpt: z.string().min(3).max(4000),
  })).max(100),
});
type Answer = { answer: string; insufficientEvidence: boolean; citations: Citation[] };
const contextObject = (input: ModelInput): Record<string, unknown> =>
  input.context && typeof input.context === "object" ? input.context as Record<string, unknown> : {};

function request(input: ModelInput, evidence: EvidenceChunk[], rejected?: unknown): ModelInput {
  const refs = evidence.map((_, i) => `E${i + 1}`);
  return {
    ...input,
    evidence,
    outputSchema: z.toJSONSchema(responseSchema.extend({
      citations: z.array(z.object({
        sourceRef: refs.length ? z.enum(refs) : z.string(),
        excerpt: z.string().min(3).max(4000),
      })).max(refs.length ? 100 : 0),
    })),
    context: {
      ...contextObject(input),
      sourceReferences: evidence.map((c, i) => ({ sourceRef: refs[i], documentVersionId: c.documentVersionId, page: c.page, section: c.section })),
      retrievalCoverage: { selectedSources: evidence.length, omittedSources: 0 },
      ...(rejected ? { rejectedAnswer: JSON.stringify(rejected).slice(0, 2000), validationFeedback: "Copy each excerpt as one exact contiguous substring of its referenced evidence. Return a corrected answer." } : {}),
    },
    instructions: input.instructions +
      " Read ALL supplied evidence before answering. Citations use {sourceRef: E1/E2/..., excerpt: exact continuous quotation}; sourceReferences bind each reference to its original page. Do not output document hashes in prose: use sourceCatalog document names and pages. Cover each part of the question, especially numeric experience thresholds, dates, presentation documents and conflicting clauses. Distinguish bidding from execution and supervisor duties. A cached 'Publicado' description does not override dated closure, evaluation, signed contract or commencement documents. Do not infer that submissions are open. If company evidence is absent, mark compliance unverified, never failed. Never treat omitted retrieval evidence as an absent requirement. Unreviewed OCR and incomplete inventory remain limitations even when every extracted source is supplied.",
  };
}

async function run(model: ModelProvider, input: ModelInput): Promise<Answer> {
  let rejected: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload = request(input, input.evidence, rejected);
    if (JSON.stringify(payload).length > INPUT_LIMIT) throw new DossierError("MODEL_CONTEXT_LIMIT", 413);
    const raw = await model.generate(payload);
    try {
      const result = responseSchema.parse(raw);
      const citations = result.citations.map(cite => {
        const match = /^E([1-9]\d*)$/.exec(cite.sourceRef);
        const chunk = match ? input.evidence[Number(match[1]) - 1] : undefined;
        if (!chunk) throw new DossierError("INVALID_CITATION", 502, true);
        return { documentVersionId: chunk.documentVersionId, ...(chunk.page ? { page: chunk.page } : {}), ...(chunk.section ? { section: chunk.section } : {}), excerpt: cite.excerpt };
      });
      const canonicalCitations = !result.insufficientEvidence || citations.length
        ? validateCitations(citations, input.evidence) : [];
      return { ...result, citations: canonicalCitations };
    } catch (error) {
      if (attempt || (!(error instanceof z.ZodError) && (!(error instanceof DossierError) || error.code !== "INVALID_CITATION"))) throw error;
      rejected = raw;
    }
  }
  throw new DossierError("MODEL_INVALID_OUTPUT", 502, true);
}

/** Full authorized corpus, with no top-k or context-budget source deletion. */
export async function generateDossierAnswer(model: ModelProvider, input: ModelInput): Promise<Answer> {
  const sourceChunksTotal = input.evidence.length;
  const corpusCoverage = { sourceChunksTotal, sourceChunksReviewed: sourceChunksTotal, documents: new Set(input.evidence.map(c => c.documentVersionId)).size };
  const fullInput = { ...input, context: { ...contextObject(input), corpusCoverage } };
  if (JSON.stringify(request(fullInput, input.evidence)).length <= BLOCK_LIMIT) return run(model, fullInput);

  // Oversize dossiers are reviewed in full, bounded blocks, then synthesized from
  // verified original quotations. There is no silent first-N source fallback.
  const batches: EvidenceChunk[][] = [];
  let batch: EvidenceChunk[] = [];
  for (const chunk of input.evidence) {
    if (JSON.stringify(request(fullInput, [...batch, chunk])).length > BLOCK_LIMIT) {
      if (!batch.length) throw new DossierError("MODEL_CONTEXT_LIMIT", 413);
      batches.push(batch); batch = [];
    }
    batch.push(chunk);
  }
  if (batch.length) batches.push(batch);
  if (batches.length > 24) throw new DossierError("CORPUS_REVIEW_LIMIT", 413);
  const reviews: Answer[] = [];
  // Two independent reads at a time bound latency and provider pressure.
  for (let offset = 0; offset < batches.length; offset += 2) {
    reviews.push(...await Promise.all(batches.slice(offset, offset + 2).map((evidence, i) => run(model, {
      ...fullInput, purpose: "tender_corpus_review", evidence,
      instructions: input.instructions + " This is one corpus block, not the complete dossier. Keep findings concise (at most 5000 characters) and quotations short (at most 300 characters per citation), without losing quantities or exceptions. Extract every fact relevant to EACH question, including requirements, exceptions, quantities, dates, contradictions and later procedural events. Cite each finding. Do not resolve conflicts using absent blocks or claim missing facts are absent in the dossier.",
      context: { ...contextObject(fullInput), block: offset + i + 1, blocks: batches.length },
    }))));
  }
  const quoted: EvidenceChunk[] = [];
  const seen = new Set<string>();
  for (const review of reviews) for (const cite of review.citations) {
    const key = JSON.stringify(cite);
    if (seen.has(key)) continue;
    seen.add(key);
    const original = input.evidence.find(c => c.documentVersionId === cite.documentVersionId && (cite.page === undefined || c.page === cite.page) && (cite.section === undefined || c.section === cite.section) && c.text.includes(cite.excerpt));
    // Validation has already normalized each quotation to the original span.
    if (!original) throw new DossierError("INVALID_CITATION", 502, true);
    quoted.push({ ...original, text: cite.excerpt });
  }
  const synthesis = { ...fullInput, evidence: quoted,
    context: { ...contextObject(fullInput), blockReviews: reviews.map(r => ({ answer: r.answer, insufficientEvidence: r.insufficientEvidence })), corpusCoverage },
    instructions: input.instructions + " Synthesize ALL block findings, preserving quantities, exceptions and disagreements. All original blocks were reviewed; supplied evidence now consists of verified original quotations, not the whole raw corpus. Say when block reviews lacked evidence; do not promise an exhaustive legal/compliance determination.",
  };
  const answer = await run(model, synthesis);
  answer.insufficientEvidence ||= reviews.some(r => r.insufficientEvidence);
  return answer;
}
