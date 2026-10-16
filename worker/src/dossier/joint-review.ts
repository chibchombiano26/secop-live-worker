import { z } from "zod/v4";
import { DossierError } from "./contracts";
import { sha256 } from "./downloads";
import type { ModelProvider } from "./model";
import type { Citation, Requirement } from "./synthesis";

const REQUEST_LIMIT = 48_000;
const REPORT_LIMIT = 200_000;
const reviewSchema = z.object({
  summary: z.string().max(6_000),
  candidates: z
    .array(
      z.object({
        left: z.number().int().nonnegative(),
        right: z.number().int().nonnegative(),
        kind: z.enum(["conflict", "amendment"]),
        reason: z.string().min(1).max(1_000),
      }),
    )
    .max(200),
});
function verificationSchemaForIds(ids: string[]) {
  if (!ids.length) throw invalidOutput();
  return z.object({
    decision: z.enum(["conflict", "amendment", "unconfirmed"]),
    reason: z.string().min(1).max(1_500),
    citationIds: z.array(z.enum(ids as [string, ...string[]])).max(20),
    previous: z.number().int().nonnegative().optional(),
    replacement: z.number().int().nonnegative().optional(),
  });
}

export type JointAmendment = {
  previous: number;
  replacement: number;
  reason: string;
  citations: Citation[];
};
export type JointReviewResult = {
  summaries: string[];
  conflicts: string[];
  amendments: JointAmendment[];
  candidateReviews: Array<{
    left: number;
    right: number;
    decision: "conflict" | "amendment" | "unconfirmed";
    reason: string;
    citations: Citation[];
  }>;
  metrics: {
    requirements: number;
    blocks: number;
    reviewGroups: number;
    comparedPairs: number;
    candidates: number;
    verifiedCandidates: number;
    completedVerifications: number;
    reviewRequests: number;
    verificationRequests: number;
    maxRequestChars: number;
  };
};
type Cache = {
  get(key: string): Promise<unknown | null>;
  put(key: string, value: unknown): Promise<void>;
};
type Candidate = {
  left: number;
  right: number;
  kind: "conflict" | "amendment";
  reason: string;
};
type Group = { indices: number[]; summaryAllowed: boolean };
type CompactRequirement = [
  number,
  string,
  Requirement["category"],
  boolean,
  string | null,
  string | null,
  Requirement["rule"],
  number[],
];

function invalidOutput(): DossierError {
  return new DossierError("MODEL_INVALID_OUTPUT", 502, true);
}
function requestChars(input: Parameters<ModelProvider["generate"]>[0]) {
  return JSON.stringify(input).length;
}
function checkRequest(input: Parameters<ModelProvider["generate"]>[0]) {
  const size = requestChars(input);
  if (size > REQUEST_LIMIT)
    throw new DossierError("MODEL_CONTEXT_LIMIT", 413, true);
  return size;
}
function sourceIndex(requirements: Requirement[]) {
  const documents = new Map<string, number>();
  const locations = new Map<string, number>();
  const sources: Array<{ document: number; page?: number; section?: string }> =
    [];
  for (const requirement of requirements)
    for (const citation of requirement.citations) {
      if (!documents.has(citation.documentVersionId))
        documents.set(citation.documentVersionId, documents.size);
      const key = JSON.stringify({
        documentVersionId: citation.documentVersionId,
        page: citation.page,
        section: citation.section,
      });
      if (!locations.has(key)) {
        locations.set(key, sources.length);
        sources.push({
          document: documents.get(citation.documentVersionId)!,
          ...(citation.page === undefined ? {} : { page: citation.page }),
          ...(citation.section === undefined
            ? {}
            : { section: citation.section }),
        });
      }
    }
  return { documents: [...documents.keys()], locations, sources };
}
function compactRequirements(
  requirements: Requirement[],
  indices: number[],
  locations: Map<string, number>,
): CompactRequirement[] {
  return indices.map((index) => {
    const requirement = requirements[index];
    return [
      index,
      requirement.wording,
      requirement.category,
      requirement.mandatory,
      requirement.lot,
      requirement.deadline,
      requirement.rule,
      requirement.citations.map((citation) =>
        locations.get(
          JSON.stringify({
            documentVersionId: citation.documentVersionId,
            page: citation.page,
            section: citation.section,
          }),
        )!,
      ),
    ] as CompactRequirement;
  });
}
function reviewInput(
  requirements: Requirement[],
  group: Group,
  index: ReturnType<typeof sourceIndex>,
  coverage: unknown,
) {
  return {
    purpose: "joint_requirement_review",
    evidence: [],
    context: {
      coverage,
      documents: index.documents,
      sources: index.sources.map((source) => [
        source.document,
        source.page ?? null,
        source.section ?? null,
      ]),
      requirements: compactRequirements(
        requirements,
        group.indices,
        index.locations,
      ),
    },
    instructions:
      "Return {summary:string,candidates:[{left:number,right:number,kind:'conflict'|'amendment',reason:string}]}. Compare every pair in the supplied requirements. Each requirement row is [globalIndex,wording,category,mandatory,lot,deadline,rule,sourceIndexes]; each source row is [documentIndex,page|null,section|null], and the documents array maps documentIndex to the full version ID. Indices are original global requirement indices. The full source excerpts are reserved for verification. Write a concise Spanish briefing only from stated requirements and preserve stated categories, mandatory status, lots, deadlines and rules. Mention partial, pending and review-required coverage accurately; never infer that an item is absent. Suggest only plausible conflicts or explicit amendments for evidence review. A later date alone is not an amendment. Do not assert an unverified conflict or amendment as fact. Keep summary under 6,000 characters and candidates under 200; if the result would exceed those bounds, return MODEL_OUTPUT_TRUNCATED by not producing a partial result.",
    outputSchema: z.toJSONSchema(reviewSchema),
  };
}
function makeGroups(
  requirements: Requirement[],
  index: ReturnType<typeof sourceIndex>,
  coverage: unknown,
): { groups: Group[]; blocks: number[][]; maxRequestChars: number } {
  if (!requirements.length)
    return { groups: [], blocks: [], maxRequestChars: 0 };
  const allIndices = requirements.map((_, index) => index);
  const wholeGroup: Group = { indices: allIndices, summaryAllowed: true };
  const wholeRequestChars = requestChars(
    reviewInput(requirements, wholeGroup, index, coverage),
  );
  if (wholeRequestChars <= REQUEST_LIMIT)
    return {
      groups: [wholeGroup],
      blocks: [allIndices],
      maxRequestChars: wholeRequestChars,
    };
  const blocks: number[][] = [];
  let block: number[] = [];
  const blockLimit = Math.floor(REQUEST_LIMIT / 2) - 1_000;
  for (let itemIndex = 0; itemIndex < requirements.length; itemIndex++) {
    const next = [...block, itemIndex];
    const sample = reviewInput(
      requirements,
      { indices: next, summaryAllowed: true },
      index,
      coverage,
    );
    if (requestChars(sample) <= blockLimit) {
      block = next;
      continue;
    }
    if (!block.length) {
      if (requestChars(sample) > REQUEST_LIMIT)
        throw new DossierError("MODEL_CONTEXT_LIMIT", 413, true);
      block = next;
      continue;
    }
    blocks.push(block);
    block = [itemIndex];
    if (
      requestChars(
        reviewInput(
          requirements,
          { indices: block, summaryAllowed: true },
          index,
          coverage,
        ),
      ) > REQUEST_LIMIT
    )
      throw new DossierError("MODEL_CONTEXT_LIMIT", 413, true);
  }
  if (block.length) blocks.push(block);
  const groups: Group[] = [];
  for (let left = 0; left < blocks.length; left++)
    for (let right = left; right < blocks.length; right++)
      groups.push({
        indices:
          left === right ? blocks[left] : [...blocks[left], ...blocks[right]],
        summaryAllowed: left === right,
      });
  // A pair of individually valid blocks can be larger than the cap. Split the
  // cross-product into deterministic windows while retaining every pair.
  const fitted: Group[] = [];
  for (const group of groups) {
    if (
      requestChars(reviewInput(requirements, group, index, coverage)) <=
      REQUEST_LIMIT
    ) {
      fitted.push(group);
      continue;
    }
    const leftBlock = blocks.find(
      (candidate) => candidate[0] === group.indices[0],
    )!;
    const rightStart = group.indices.find(
      (index) => !leftBlock.includes(index),
    );
    if (rightStart === undefined)
      throw new DossierError("MODEL_CONTEXT_LIMIT", 413, true);
    const rightBlock = blocks.find((candidate) => candidate[0] === rightStart)!;
    for (const left of leftBlock)
      for (const right of rightBlock) {
        const indices = [...new Set([left, right])];
        const split = { indices, summaryAllowed: false };
        if (
          requestChars(reviewInput(requirements, split, index, coverage)) >
          REQUEST_LIMIT
        )
          throw new DossierError("MODEL_CONTEXT_LIMIT", 413, true);
        fitted.push(split);
      }
  }
  const counts = requirements.map(() => 0);
  for (const group of fitted)
    for (const index of group.indices) counts[index]++;
  if (counts.some((count) => count === 0))
    throw new DossierError("MODEL_CONTEXT_LIMIT", 413, true);
  const maxRequestChars = Math.max(
    ...fitted.map((group) =>
      requestChars(reviewInput(requirements, group, index, coverage)),
    ),
  );
  return { groups: fitted, blocks, maxRequestChars };
}

export async function reviewJointRequirements(
  requirements: Requirement[],
  model: ModelProvider,
  coverage: unknown,
  cache: Cache,
  checkpoint?: (progress: Record<string, unknown>) => Promise<void>,
): Promise<JointReviewResult> {
  const index = sourceIndex(requirements);
  const plan = makeGroups(requirements, index, coverage);
  const summaries = new Set<string>();
  const candidates = new Map<string, Candidate>();
  let reviewRequests = 0;
  for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex++) {
    const group = plan.groups[groupIndex];
    await checkpoint?.({
      phase: "joint_review",
      reviewGroupsCompleted: groupIndex,
      reviewGroupsTotal: plan.groups.length,
    });
    const input = reviewInput(requirements, group, index, coverage);
    const key = await sha256(
      `joint-review:v1:${model.id}:${JSON.stringify(input)}`,
    );
    const cached = await cache.get(key);
    let result: z.infer<typeof reviewSchema>;
    if (cached !== null) {
      result = reviewSchema.parse(cached);
    } else {
      const raw = await model.generate(input);
      try {
        result = reviewSchema.parse(raw);
      } catch {
        throw invalidOutput();
      }
      for (const candidate of result.candidates) {
        if (
          candidate.left === candidate.right ||
          !group.indices.includes(candidate.left) ||
          !group.indices.includes(candidate.right)
        )
          throw invalidOutput();
      }
      await cache.put(key, result);
      reviewRequests++;
    }
    if (group.summaryAllowed && result.summary.trim())
      summaries.add(result.summary.trim());
    for (const candidate of result.candidates) {
      if (
        candidate.left === candidate.right ||
        !group.indices.includes(candidate.left) ||
        !group.indices.includes(candidate.right)
      )
        throw invalidOutput();
      const pair =
        candidate.left < candidate.right
          ? `${candidate.left}:${candidate.right}:${candidate.kind}`
          : `${candidate.right}:${candidate.left}:${candidate.kind}`;
      if (!candidates.has(pair)) candidates.set(pair, candidate);
    }
    await checkpoint?.({
      phase: "joint_review",
      reviewGroupsCompleted: groupIndex + 1,
      reviewGroupsTotal: plan.groups.length,
    });
  }
  const amendments: JointAmendment[] = [];
  const conflicts: string[] = [];
  const candidateReviews: JointReviewResult["candidateReviews"] = [];
  let verificationRequests = 0;
  let maxRequestChars = plan.maxRequestChars;
  const reviewCandidates = [...candidates.values()];
  for (let index = 0; index < reviewCandidates.length; index++) {
    const candidate = reviewCandidates[index];
    await checkpoint?.({
      phase: "joint_verification",
      candidatesCompleted: index,
      candidatesTotal: reviewCandidates.length,
    });
    const left = requirements[candidate.left];
    const right = requirements[candidate.right];
    const evidence: Array<{
      documentVersionId: string;
      page?: number;
      section?: string;
      id: string;
      text: string;
      index: number;
    }> = [];
    const citationMap = new Map<string, { side: number; citation: Citation }>();
    for (const [side, globalIndex] of [
      [0, candidate.left],
      [1, candidate.right],
    ] as const) {
      for (
        let citationIndex = 0;
        citationIndex < requirements[globalIndex].citations.length;
        citationIndex++
      ) {
        const citation = requirements[globalIndex].citations[citationIndex];
        const id = `r${globalIndex}c${citationIndex}`;
        citationMap.set(id, { side, citation });
        evidence.push({
          documentVersionId: citation.documentVersionId,
          ...(citation.page === undefined ? {} : { page: citation.page }),
          ...(citation.section === undefined
            ? {}
            : { section: citation.section }),
          id,
          text: citation.excerpt,
          index: citationIndex,
        });
      }
    }
    const verificationInput = {
      purpose: "joint_conflict_verification",
      evidence,
      context: {
        candidate: {
          left: candidate.left,
          right: candidate.right,
          kind: candidate.kind,
        },
        requirements: [
          {
            index: candidate.left,
            wording: left.wording,
            category: left.category,
            mandatory: left.mandatory,
            lot: left.lot,
            deadline: left.deadline,
            rule: left.rule,
          },
          {
            index: candidate.right,
            wording: right.wording,
            category: right.category,
            mandatory: right.mandatory,
            lot: right.lot,
            deadline: right.deadline,
            rule: right.rule,
          },
        ],
      },
      instructions:
        "Return {decision:'conflict'|'amendment'|'unconfirmed',reason:string,citationIds:string[],previous?:number,replacement?:number}. Verify the proposed relationship using only the two original requirement wordings and their exact quoted evidence. Cite valid supplied evidence IDs from BOTH requirements for any confirmed conflict or amendment. Do not infer an amendment from later chronology; the text must explicitly change a prior term. If evidence does not establish the relationship, return unconfirmed. For an amendment, previous and replacement must be the original global requirement indices and the text must explicitly establish that direction. Never invent quotations, IDs or facts.",
      outputSchema: z.toJSONSchema(
        verificationSchemaForIds([...citationMap.keys()]),
      ),
    };
    maxRequestChars = Math.max(
      maxRequestChars,
      checkRequest(verificationInput),
    );
    const key = await sha256(
      `joint-verify:v1:${model.id}:${JSON.stringify(verificationInput)}`,
    );
    const cached = await cache.get(key);
    const verificationSchema = verificationSchemaForIds([
      ...citationMap.keys(),
    ]);
    let verified: z.infer<typeof verificationSchema>;
    if (cached !== null) {
      try {
        verified = verificationSchema.parse(cached);
      } catch {
        throw invalidOutput();
      }
    } else {
      const raw = await model.generate(verificationInput);
      try {
        verified = verificationSchema.parse(raw);
      } catch {
        throw invalidOutput();
      }
      verificationRequests++;
    }
    const citations: Citation[] = [];
    let sides = new Set<number>();
    for (const id of verified.citationIds) {
      const found = citationMap.get(id);
      if (!found) throw invalidOutput();
      sides.add(found.side);
      citations.push(found.citation);
    }
    if (verified.decision !== "unconfirmed" && sides.size !== 2)
      throw invalidOutput();
    if (verified.decision === "amendment") {
      if (
        verified.previous === undefined ||
        verified.replacement === undefined ||
        verified.previous === verified.replacement ||
        ![candidate.left, candidate.right].includes(verified.previous) ||
        ![candidate.left, candidate.right].includes(verified.replacement)
      )
        throw invalidOutput();
      amendments.push({
        previous: verified.previous,
        replacement: verified.replacement,
        reason: verified.reason,
        citations,
      });
    }
    const review = {
      left: candidate.left,
      right: candidate.right,
      decision: verified.decision,
      reason: verified.reason,
      citations,
    };
    candidateReviews.push(review);
    if (verified.decision === "conflict")
      conflicts.push(
        `Conflicto verificado entre requisitos: ${verified.reason}`,
      );
    if (cached === null) await cache.put(key, verified);
    await checkpoint?.({
      phase: "joint_verification",
      candidatesCompleted: index + 1,
      candidatesTotal: reviewCandidates.length,
    });
  }
  const result: JointReviewResult = {
    summaries: [...summaries],
    conflicts,
    amendments,
    candidateReviews,
    metrics: {
      requirements: requirements.length,
      blocks: plan.blocks.length,
      reviewGroups: plan.groups.length,
      comparedPairs: (requirements.length * (requirements.length - 1)) / 2,
      candidates: reviewCandidates.length,
      verifiedCandidates: candidateReviews.filter(
        (review) => review.decision !== "unconfirmed",
      ).length,
      completedVerifications: candidateReviews.length,
      reviewRequests,
      verificationRequests,
      maxRequestChars,
    },
  };
  if (JSON.stringify(result).length > REPORT_LIMIT)
    throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
  return result;
}
