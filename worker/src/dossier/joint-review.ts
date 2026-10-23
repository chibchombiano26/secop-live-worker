import { z } from "zod/v4";
import { DossierError } from "./contracts";
import { sha256 } from "./downloads";
import {
  modelJointReviewConcurrency,
  modelJointVerifyConcurrency,
} from "./model-concurrency";
import type { ModelInput, ModelProvider } from "./model";
import type { Citation, Requirement } from "./synthesis";

const REQUEST_LIMIT = 48_000;
// This aggregates independently bounded responses, rather than one inference.
const REPORT_LIMIT = 28_000_000;
// Bump when the joint-review prompt, planner, or cached aggregate shape changes.
const REVIEW_PLAN_VERSION = 1;
const candidateSchema = z.object({
  left: z.number().int().nonnegative(),
  right: z.number().int().nonnegative(),
  kind: z.enum(["conflict", "amendment"]),
  reason: z.string().min(1).max(1_000),
});
const reviewSchema = z.object({
  summary: z.string().max(6_000),
  candidates: z.array(candidateSchema).max(200),
});
const reviewAggregateSchema = z.object({
  version: z.literal(REVIEW_PLAN_VERSION),
  summaries: z.array(z.string()),
  candidates: z.array(candidateSchema),
});
function verificationSchemaForIds(ids: string[]) {
  if (!ids.length) throw invalidOutput();
  return z.object({
    decision: z.enum(["conflict", "amendment", "unconfirmed"]),
    reason: z.string().min(1).max(1_500),
    citationIds: z.array(z.enum(ids as [string, ...string[]])).max(20),
    changeExcerpt: z.string().min(1).max(4_000).optional(),
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
type VerificationValue = z.infer<ReturnType<typeof verificationSchemaForIds>>;
type VerificationTask = {
  index: number;
  taskId: string;
  candidate: Candidate;
  input: ModelInput;
  inputChars: number;
  key: string;
  citationMap: Map<string, { side: number; citation: Citation }>;
  schema: ReturnType<typeof verificationSchemaForIds>;
};
type CandidateScopes = { left: number[]; right: number[] };
type Group = {
  indices: number[];
  summaryAllowed: boolean;
  scopes?: CandidateScopes;
};
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
function splitVerificationBatch(error: unknown) {
  return (
    error instanceof DossierError &&
    (error.code === "MODEL_INVALID_OUTPUT" ||
      error.code === "MODEL_OUTPUT_TRUNCATED")
  );
}
function candidateCapExceeded(error: z.ZodError) {
  return error.issues.some(
    (issue) =>
      issue.code === "too_big" &&
      issue.path.length === 1 &&
      issue.path[0] === "candidates",
  );
}
function logInvalidGroupSchema(groupIndex: number, error: z.ZodError) {
  console.error(
    JSON.stringify({
      event: "joint_review_invalid_output",
      groupIndex,
      category: "schema",
      issues: error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        ),
        type: issue.code,
      })),
    }),
  );
}
function logInvalidGroupCandidate(
  groupIndex: number,
  candidate: Candidate,
  group: Group,
) {
  const indices = group.indices;
  console.error(
    JSON.stringify({
      event: "joint_review_invalid_output",
      groupIndex,
      category:
        candidate.left === candidate.right
          ? "candidate_self"
          : "candidate_scope",
      left: candidate.left,
      right: candidate.right,
      allowedIndexMin: Math.min(...indices),
      allowedIndexMax: Math.max(...indices),
      allowedIndexCount: indices.length,
    }),
  );
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
function groupSourceIndex(
  requirements: Requirement[],
  group: Group,
  index: ReturnType<typeof sourceIndex>,
) {
  const documents: string[] = [];
  const documentIndexes = new Map<number, number>();
  const sources: Array<{ document: number; page?: number; section?: string }> =
    [];
  const sourceIndexes = new Map<number, number>();
  const locations = new Map<string, number>();
  for (const requirementIndex of group.indices)
    for (const citation of requirements[requirementIndex].citations) {
      const key = JSON.stringify({
        documentVersionId: citation.documentVersionId,
        page: citation.page,
        section: citation.section,
      });
      const globalSource = index.locations.get(key)!;
      if (!sourceIndexes.has(globalSource)) {
        const source = index.sources[globalSource];
        let document = documentIndexes.get(source.document);
        if (document === undefined) {
          document = documents.length;
          documentIndexes.set(source.document, document);
          documents.push(index.documents[source.document]);
        }
        sourceIndexes.set(globalSource, sources.length);
        sources.push({ ...source, document });
      }
      locations.set(key, sourceIndexes.get(globalSource)!);
    }
  return { documents, sources, locations };
}
function reviewInput(
  requirements: Requirement[],
  group: Group,
  index: ReturnType<typeof sourceIndex>,
  coverage: unknown,
) {
  const groupIndex = groupSourceIndex(requirements, group, index);
  return {
    purpose: "joint_requirement_review",
    evidence: [],
    context: {
      coverage,
      documents: groupIndex.documents,
      sources: groupIndex.sources.map((source) => [
        source.document,
        source.page ?? null,
        source.section ?? null,
      ]),
      requirements: compactRequirements(
        requirements,
        group.indices,
        groupIndex.locations,
      ),
    },
    instructions:
      "Return {summary:string,candidates:[{left:number,right:number,kind:'conflict'|'amendment',reason:string}]}. Compare every allowed pair: when the left and right candidate index ranges in the output schema match, compare every unordered pair in that range; when the ranges differ, compare every left-to-right pair across those ranges. Do not omit distant pairs within the allowed scope. Each requirement row is [globalIndex,wording,category,mandatory,lot,deadline,rule,sourceIndexes]; each source row is [documentIndex,page|null,section|null], and the documents array maps documentIndex to the full version ID. Indices are original global requirement indices. The full source excerpts are reserved for verification. Do not state counts of requirements, conflicts, amendments or documents in the summary: these are computed by the backend after verification. Include scope and deliverables, eligibility, experience, financial thresholds with units and periods, required documents, deadlines, evaluation, guarantees and missing evidence when established. Write a concise Spanish briefing only from stated requirements and preserve stated categories, mandatory status, lots, deadlines and rules. Mention partial, pending and review-required coverage accurately; never infer that an item is absent. Suggest only plausible conflicts or explicit amendments for evidence review. A later date alone is not an amendment. Do not assert an unverified conflict or amendment as fact. Keep summary under 6,000 characters and candidates under 200; if the result would exceed those bounds, return MODEL_OUTPUT_TRUNCATED by not producing a partial result.",
    outputSchema: z.toJSONSchema(reviewSchema),
  };
}
function candidateScopes(group: Group, blocks: number[][]) {
  if (group.summaryAllowed)
    return { left: group.indices, right: group.indices };
  const leftBlock = blocks.find((block) => block.includes(group.indices[0]));
  if (!leftBlock) throw invalidOutput();
  const left = group.indices.filter((index) => leftBlock.includes(index));
  const right = group.indices.filter((index) => !leftBlock.includes(index));
  if (!left.length || !right.length) throw invalidOutput();
  return { left, right };
}
function boundCandidateIndices(
  input: ReturnType<typeof reviewInput>,
  scopes: ReturnType<typeof candidateScopes>,
) {
  const schema = input.outputSchema as Record<string, any>;
  const properties = schema.properties as Record<string, any>;
  const candidates = properties.candidates as Record<string, any>;
  const items = candidates.items as Record<string, any>;
  const itemProperties = items.properties as Record<string, any>;
  const range = (indices: number[]) => ({
    minimum: Math.min(...indices),
    maximum: Math.max(...indices),
  });
  return {
    ...input,
    outputSchema: {
      ...schema,
      properties: {
        ...properties,
        candidates: {
          ...candidates,
          items: {
            ...items,
            properties: {
              ...itemProperties,
              left: { ...itemProperties.left, ...range(scopes.left) },
              right: { ...itemProperties.right, ...range(scopes.right) },
            },
          },
        },
      },
    },
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
  const blockLimit = 27_000;
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
  options?: {
    concurrency?: number;
    revision?: number;
    resume?: { cursor: number; fingerprint: string };
    verificationConcurrency?: number;
    resumeVerification?: { cursor: number; fingerprint: string };
  },
): Promise<JointReviewResult> {
  const reviewConcurrency = modelJointReviewConcurrency(options?.concurrency);
  const verificationConcurrency = modelJointVerifyConcurrency(
    options?.verificationConcurrency,
  );
  const index = sourceIndex(requirements);
  const plan = makeGroups(requirements, index, coverage);
  const resumePlan = {
    coverage,
    blocks: plan.blocks,
    groups: plan.groups,
    documents: index.documents,
    sources: index.sources,
    requirements: compactRequirements(
      requirements,
      requirements.map((_, requirementIndex) => requirementIndex),
      index.locations,
    ),
  };
  const resumeFingerprint = await sha256(
    [
      `joint-review-plan:v${REVIEW_PLAN_VERSION}`,
      model.id,
      options?.revision ?? 0,
      JSON.stringify(resumePlan),
    ].join(":"),
  );
  const aggregateKey = `joint.aggregate.v${REVIEW_PLAN_VERSION}.${resumeFingerprint}`;
  const cachedAggregate = await cache.get(aggregateKey);
  let aggregate: z.infer<typeof reviewAggregateSchema> | null = null;
  if (cachedAggregate !== null) {
    try {
      aggregate = reviewAggregateSchema.parse(cachedAggregate);
    } catch {
      throw invalidOutput();
    }
  }
  const requestedCursor = options?.resume?.cursor;
  const cursorIsValid =
    typeof requestedCursor === "number" &&
    Number.isSafeInteger(requestedCursor) &&
    requestedCursor >= 0 &&
    requestedCursor <= plan.groups.length;
  const resumeCursor =
    aggregate !== null
      ? plan.groups.length
      : options?.resume?.fingerprint === resumeFingerprint && cursorIsValid
        ? requestedCursor
        : 0;
  const summaries = new Set(aggregate?.summaries ?? []);
  const candidates = new Map<string, Candidate>();
  for (const candidate of aggregate?.candidates ?? []) {
    if (
      candidate.left >= requirements.length ||
      candidate.right >= requirements.length ||
      candidate.left === candidate.right
    )
      throw invalidOutput();
    const pair =
      candidate.left < candidate.right
        ? `${candidate.left}:${candidate.right}:${candidate.kind}`
        : `${candidate.right}:${candidate.left}:${candidate.kind}`;
    candidates.set(pair, candidate);
  }
  let reviewRequests = 0;
  const results: Array<{ summary: string; candidates: Candidate[] }> = [];
  let completed = resumeCursor;
  let reviewGroupsCursor = resumeCursor;
  const completedOutOfOrder = new Set<number>();
  let maxSentReviewRequestChars = 0;
  let progressWrites = Promise.resolve();
  await checkpoint?.({
    phase: "joint_review",
    reviewGroupsCompleted: resumeCursor,
    reviewGroupsTotal: plan.groups.length,
    reviewGroupsCursor,
    reviewGroupsFingerprint: resumeFingerprint,
  });
  // Joint output grows with the pairs under review, so a single large
  // group can exceed one bounded inference even when its input fits.
  // Truncated within-group reviews split into two diagonal groups plus their
  // cross product. Cross-block groups split one axis at a time, so every
  // planned pair remains covered while each inference gets smaller.
  function scopesForGroup(group: Group): CandidateScopes {
    if (group.scopes) return group.scopes;
    if (group.summaryAllowed)
      return { left: group.indices, right: group.indices };
    try {
      return candidateScopes(group, plan.blocks);
    } catch (error) {
      if (!(error instanceof DossierError)) throw error;
      return { left: group.indices, right: group.indices };
    }
  }
  function isWithinGroup(scopes: CandidateScopes): boolean {
    return (
      scopes.left.length === scopes.right.length &&
      scopes.left.every((index, position) => index === scopes.right[position])
    );
  }
  function splitGroup(group: Group, scopes: CandidateScopes): Group[] {
    if (isWithinGroup(scopes)) {
      if (scopes.left.length < 2) return [];
      const middle = Math.ceil(scopes.left.length / 2);
      const left = scopes.left.slice(0, middle);
      const right = scopes.left.slice(middle);
      return [
        ...(left.length
          ? [{
              indices: left,
              summaryAllowed: group.summaryAllowed,
              scopes: { left, right: left },
            }]
          : []),
        ...(left.length && right.length
          ? [{
              indices: [...left, ...right],
              summaryAllowed: false,
              scopes: { left, right },
            }]
          : []),
        ...(right.length
          ? [{
              indices: right,
              summaryAllowed: group.summaryAllowed,
              scopes: { left: right, right },
            }]
          : []),
      ];
    }
    const splitLeft = scopes.left.length >= scopes.right.length;
    const axis = splitLeft ? scopes.left : scopes.right;
    if (axis.length < 2) return [];
    const middle = Math.ceil(axis.length / 2);
    const first = axis.slice(0, middle);
    const second = axis.slice(middle);
    const makeCrossGroup = (
      left: number[],
      right: number[],
      summaryAllowed: boolean,
    ): Group => ({
      indices: [...new Set([...left, ...right])],
      summaryAllowed,
      scopes: { left, right },
    });
    return splitLeft
      ? [
          makeCrossGroup(first, scopes.right, group.summaryAllowed),
          makeCrossGroup(second, scopes.right, false),
        ]
      : [
          makeCrossGroup(scopes.left, first, group.summaryAllowed),
          makeCrossGroup(scopes.left, second, false),
        ];
  }
  async function reviewChildren(children: Group[]) {
    const candidates: Candidate[] = [];
    const summaries: string[] = [];
    // Keep recursive work sequential within each worker. The outer plan
    // bounds total concurrent review requests.
    for (const child of children) {
      const result = await reviewOne(child);
      if (result.summary.trim()) summaries.push(result.summary.trim());
      candidates.push(...result.candidates);
    }
    return { summary: summaries.join("\n"), candidates };
  }
  async function reviewOne(group: Group): Promise<{
    summary: string;
    candidates: Candidate[];
  }> {
    const input = reviewInput(requirements, group, index, coverage);
    const scopes = scopesForGroup(group);
    const key = await sha256(
      `joint-review:v3:${model.id}:${JSON.stringify({
        input,
        scopes,
        summaryAllowed: group.summaryAllowed,
      })}`,
    );
    const cached = await cache.get(key);
    if (cached !== null) {
      if (
        typeof cached === "object" &&
        cached !== null &&
        "split" in cached &&
        cached.split === true
      ) {
        const children = splitGroup(group, scopesForGroup(group));
        if (!children.length)
          throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
        return reviewChildren(children);
      }
      const result = reviewSchema.parse(cached);
      if (result.candidates.length === 200) {
        const children = splitGroup(group, scopesForGroup(group));
        if (!children.length)
          throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
        await cache.put(key, { split: true });
        return reviewChildren(children);
      }
      for (const candidate of result.candidates) {
        if (
          candidate.left === candidate.right ||
          !scopes.left.includes(candidate.left) ||
          !scopes.right.includes(candidate.right)
        ) {
          logInvalidGroupCandidate(groupLogIndex(group), candidate, group);
          throw invalidOutput();
        }
      }
      return {
        summary: group.summaryAllowed ? result.summary : "",
        candidates: result.candidates,
      };
    }
    const generatedInput = boundCandidateIndices(input, scopes);
    const generatedInputChars = checkRequest(generatedInput);
    maxSentReviewRequestChars = Math.max(
      maxSentReviewRequestChars,
      generatedInputChars,
    );
    let result: z.infer<typeof reviewSchema>;
    try {
      const raw = await model.generate(generatedInput);
      try {
        result = reviewSchema.parse(raw);
      } catch (error) {
        if (error instanceof z.ZodError && candidateCapExceeded(error))
          throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
        if (error instanceof z.ZodError)
          logInvalidGroupSchema(groupLogIndex(group), error);
        throw invalidOutput();
      }
    } catch (error) {
      if (
        !(error instanceof DossierError) ||
        error.code !== "MODEL_OUTPUT_TRUNCATED"
      )
        throw error;
      const children = splitGroup(group, scopes);
      if (!children.length) throw error;
      await cache.put(key, { split: true });
      return reviewChildren(children);
    }
    if (result.candidates.length === 200) {
      const children = splitGroup(group, scopes);
      if (!children.length)
        throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
      await cache.put(key, { split: true });
      return reviewChildren(children);
    }
    for (const candidate of result.candidates) {
      if (
        candidate.left === candidate.right ||
        !scopes.left.includes(candidate.left) ||
        !scopes.right.includes(candidate.right)
      ) {
        logInvalidGroupCandidate(groupLogIndex(group), candidate, group);
        throw invalidOutput();
      }
    }
    await cache.put(key, result);
    reviewRequests++;
    return {
      summary: group.summaryAllowed ? result.summary : "",
      candidates: result.candidates,
    };
  }
  function groupLogIndex(group: Group): number {
    const position = plan.groups.indexOf(group);
    return position === -1 ? 0 : position;
  }
  async function loadGroupResult(groupIndex: number) {
    const group = plan.groups[groupIndex];
    const merged = await reviewOne(group);
    for (const candidate of merged.candidates) {
      if (
        candidate.left === candidate.right ||
        !scopesForGroup(group).left.includes(candidate.left) ||
        !scopesForGroup(group).right.includes(candidate.right)
      ) {
        logInvalidGroupCandidate(groupIndex, candidate, group);
        throw invalidOutput();
      }
    }
    // Merged leaves were schema-validated individually; the aggregate keeps
    // every candidate instead of re-applying the per-inference 200 cap.
    const result: z.infer<typeof reviewSchema> = {
      summary: merged.summary,
      candidates: merged.candidates,
    };
    return result;
  }
  async function reviewGroup(groupIndex: number) {
    const result = await loadGroupResult(groupIndex);
    results[groupIndex] = result;
    const count = ++completed;
    completedOutOfOrder.add(groupIndex);
    while (completedOutOfOrder.delete(reviewGroupsCursor))
      reviewGroupsCursor++;
    progressWrites = progressWrites.then(async () => {
      await checkpoint?.({
        phase: "joint_review",
        reviewGroupsCompleted: count,
        reviewGroupsTotal: plan.groups.length,
        reviewGroupsCursor,
        reviewGroupsFingerprint: resumeFingerprint,
      });
    });
    await progressWrites;
  }
  let nextGroup = resumeCursor;
  let failed = false;
  let failure: unknown;
  async function visitGroups() {
    while (!failed && nextGroup < plan.groups.length) {
      const groupIndex = nextGroup++;
      try {
        await reviewGroup(groupIndex);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }
  // Settle all in-flight model/cache work before yielding, then merge in the
  // original plan order so completion timing cannot select different candidates.
  if (aggregate === null)
    await Promise.all(
      Array.from(
        { length: Math.min(reviewConcurrency, plan.groups.length) },
        visitGroups,
      ),
    );
  await progressWrites;
  await checkpoint?.({
    phase: "joint_review",
    reviewGroupsCompleted: completed,
    reviewGroupsTotal: plan.groups.length,
    reviewGroupsCursor,
    reviewGroupsFingerprint: resumeFingerprint,
    forceCheckpoint: true,
  });
  if (failed) throw failure;
  // Resume skips the durable prefix while work is still incomplete. Once all
  // remaining groups finish, reload that prefix once to preserve the
  // original ordered aggregate of summaries and candidates.
  if (aggregate === null) {
    let nextPrefixGroup = 0;
    async function visitCachedPrefix() {
      while (nextPrefixGroup < resumeCursor) {
        const groupIndex = nextPrefixGroup++;
        results[groupIndex] = await loadGroupResult(groupIndex);
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(reviewConcurrency, resumeCursor) },
        visitCachedPrefix,
      ),
    );
  }
  if (aggregate === null) {
    for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex++) {
      const group = plan.groups[groupIndex];
      const result = results[groupIndex];
      if (group.summaryAllowed && result.summary.trim())
        summaries.add(result.summary.trim());
      for (const candidate of result.candidates) {
        if (
          candidate.left === candidate.right ||
          !scopesForGroup(group).left.includes(candidate.left) ||
          !scopesForGroup(group).right.includes(candidate.right)
        )
          throw invalidOutput();
        const pair =
          candidate.left < candidate.right
            ? `${candidate.left}:${candidate.right}:${candidate.kind}`
            : `${candidate.right}:${candidate.left}:${candidate.kind}`;
        if (!candidates.has(pair)) candidates.set(pair, candidate);
      }
    }
    const savedAggregate = {
      version: REVIEW_PLAN_VERSION,
      summaries: [...summaries],
      candidates: [...candidates.values()],
    };
    if (
      new TextEncoder().encode(JSON.stringify(savedAggregate)).byteLength <=
      REPORT_LIMIT
    )
      await cache.put(aggregateKey, savedAggregate);
  }
  const amendments: JointAmendment[] = [];
  const conflicts: string[] = [];
  const candidateReviews: JointReviewResult["candidateReviews"] = [];
  let verificationRequests = 0;
  let maxRequestChars = maxSentReviewRequestChars;
  const reviewCandidates = [...candidates.values()];
  const verificationFingerprint = await sha256(
    [
      "joint-review-verification:v1",
      resumeFingerprint,
      JSON.stringify(
        reviewCandidates.map(({ left, right, kind }) => [left, right, kind]),
      ),
    ].join(":"),
  );
  const requestedVerificationCursor = options?.resumeVerification?.cursor;
  const verificationCursorIsValid =
    typeof requestedVerificationCursor === "number" &&
    Number.isSafeInteger(requestedVerificationCursor) &&
    requestedVerificationCursor >= 0 &&
    requestedVerificationCursor <= reviewCandidates.length;
  let verificationCursor =
    options?.resumeVerification?.fingerprint === verificationFingerprint &&
    verificationCursorIsValid
      ? requestedVerificationCursor
      : 0;
  const resumeVerificationPrefix = verificationCursor;
  const verificationResults: Array<{
    candidate: Candidate;
    verified: VerificationValue;
    citations: Citation[];
  }> = new Array(reviewCandidates.length);
  const completedVerificationIndices = new Set<number>();
  let verificationProgressWrites = Promise.resolve();
  await checkpoint?.({
    phase: "joint_verification",
    candidatesCompleted: verificationCursor,
    candidatesTotal: reviewCandidates.length,
    verificationFingerprint,
  });
  const verificationInstructions =
    "Return {decision:'conflict'|'amendment'|'unconfirmed',reason:string,citationIds:string[],previous?:number,replacement?:number,changeExcerpt?:string}. For an amendment, changeExcerpt must copy a contiguous passage from the replacement source that explicitly modifies or replaces the prior term. Without that passage return unconfirmed. Verify the proposed relationship using only the two original requirement wordings and their exact quoted evidence. Cite valid supplied evidence IDs from BOTH requirements for any confirmed conflict or amendment. A conflict means the two obligations are mutually incompatible for the same scope and period. Repeated obligations, a longer wording, extra detail, or compatible general and specific terms are NOT conflicts. An amendment requires an explicit source statement replacing, correcting or modifying an identified earlier term. Two different evaluation criteria or a condition described elsewhere are NOT evidence of an amendment by themselves. Do not infer an amendment from later chronology; the text must explicitly change a prior term. If evidence does not establish the relationship, return unconfirmed. For an amendment, previous and replacement must be the original global requirement indices and the text must explicitly establish that direction. Never invent quotations, IDs or facts.";
  async function buildVerificationTask(index: number): Promise<VerificationTask> {
    const candidate = reviewCandidates[index];
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
    const verificationSchema = verificationSchemaForIds([
      ...citationMap.keys(),
    ]);
    const verificationInput: ModelInput = {
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
      instructions: verificationInstructions,
      outputSchema: z.toJSONSchema(verificationSchema),
    };
    const key = await sha256(
      `joint-verify:v1:${model.id}:${JSON.stringify(verificationInput)}`,
    );
    return {
      index,
      taskId: `candidate-${index}`,
      candidate,
      input: verificationInput,
      inputChars: requestChars(verificationInput),
      key,
      citationMap,
      schema: verificationSchema,
    };
  }
  function validateVerification(
    task: VerificationTask,
    value: unknown,
  ): { candidate: Candidate; verified: VerificationValue; citations: Citation[] } {
    let verified: VerificationValue;
    try {
      verified = task.schema.parse(value) as VerificationValue;
    } catch {
      throw invalidOutput();
    }
    const citations: Citation[] = [];
    let sides = new Set<number>();
    for (const id of verified.citationIds) {
      const found = task.citationMap.get(id);
      if (!found) throw invalidOutput();
      sides.add(found.side);
      citations.push(found.citation);
    }
    if (verified.decision !== "unconfirmed" && sides.size !== 2)
      throw invalidOutput();
    if (verified.decision === "amendment") {
      const passage = verified.changeExcerpt;
      const changeLanguage =
        /modific|sustituy|reemplaz|rectific|corrig|quedar[aá]|dejar? sin efecto|amend|replac|supersed/iu;
      const replacementEvidence = citations.filter((citation) =>
        requirements[verified.replacement ?? -1]?.citations.some(
          (original) => original === citation,
        ),
      );
      if (
        !passage ||
        !changeLanguage.test(passage) ||
        !replacementEvidence.some((citation) =>
          citation.excerpt.includes(passage),
        )
      ) {
        verified = {
          ...verified,
          decision: "unconfirmed",
          reason:
            "No se aportó un pasaje literal que modifique expresamente el requisito anterior. " +
            verified.reason,
        };
      }
    }
    if (
      verified.decision === "amendment" &&
      (verified.previous === undefined ||
        verified.replacement === undefined ||
        verified.previous === verified.replacement ||
        ![task.candidate.left, task.candidate.right].includes(verified.previous) ||
        ![task.candidate.left, task.candidate.right].includes(verified.replacement))
    )
      throw invalidOutput();
    return { candidate: task.candidate, verified, citations };
  }
  async function completeVerification(
    task: VerificationTask,
    value: { candidate: Candidate; verified: VerificationValue; citations: Citation[] },
    cacheMiss: boolean,
  ) {
    if (cacheMiss) await cache.put(task.key, value.verified);
    verificationResults[task.index] = value;
    completedVerificationIndices.add(task.index);
    const previousCursor = verificationCursor;
    while (completedVerificationIndices.delete(verificationCursor))
      verificationCursor++;
    if (verificationCursor !== previousCursor) {
      const count = verificationCursor;
      verificationProgressWrites = verificationProgressWrites.then(
        async () => {
          await checkpoint?.({
            phase: "joint_verification",
            candidatesCompleted: count,
            candidatesTotal: reviewCandidates.length,
            verificationFingerprint,
          });
        },
      );
      await verificationProgressWrites;
    }
  }
  async function verifySingleton(task: VerificationTask) {
    checkRequest(task.input);
    maxRequestChars = Math.max(maxRequestChars, task.inputChars);
    verificationRequests++;
    const raw = await model.generate(task.input);
    const value = validateVerification(task, raw);
    await completeVerification(task, value, true);
  }
  function batchVerificationInput(tasks: VerificationTask[]) {
    const taskIds = tasks.map((task) => task.taskId);
    const batchCitationMappings = new Map<string, Map<string, string>>();
    const citationIds = [
      ...tasks.flatMap((task) => {
        const mapping = new Map<string, string>();
        batchCitationMappings.set(task.taskId, mapping);
        const originalIds = [...task.citationMap.keys()];
        return task.input.evidence.map((_evidence, evidenceIndex) => {
          const batchId = `${task.taskId}-e${evidenceIndex}`;
          mapping.set(batchId, originalIds[evidenceIndex]);
          return batchId;
        });
      }),
    ];
    const itemSchema = z.object({
      taskId: z.enum(taskIds as [string, ...string[]]),
      decision: z.enum(["conflict", "amendment", "unconfirmed"]),
      reason: z.string().min(1).max(1_500),
      citationIds: z.array(z.enum(citationIds as [string, ...string[]])).max(20),
      changeExcerpt: z.string().min(1).max(4_000).optional(),
      previous: z.number().int().nonnegative().optional(),
      replacement: z.number().int().nonnegative().optional(),
    });
    const batchSchema = z.object({
      results: z.array(itemSchema).length(tasks.length),
    });
    const batchInput: ModelInput = {
      purpose: "joint_conflict_verification_batch",
      evidence: [],
      context: {
        tasks: tasks.map((task) => {
          const context = task.input.context as {
            candidate: unknown;
            requirements: unknown;
          };
          return {
            taskId: task.taskId,
            evidence: task.input.evidence.map((evidence, evidenceIndex) => ({
              ...evidence,
              id: `${task.taskId}-e${evidenceIndex}`,
            })),
            candidate: context.candidate,
            requirements: context.requirements,
          };
        }),
      },
      instructions:
        `Verify every task independently and return exactly one result for each taskId. Evidence IDs are local to their task; cite only that task's supplied IDs from both requirements for a confirmed result. Do not combine facts or citations between tasks. ${verificationInstructions}`,
      outputSchema: z.toJSONSchema(batchSchema),
    };
    return { input: batchInput, schema: batchSchema, batchCitationMappings };
  }
  async function verifyBatch(tasks: VerificationTask[]) {
    if (tasks.length === 1) {
      await verifySingleton(tasks[0]);
      return;
    }
    const { input, schema, batchCitationMappings } = batchVerificationInput(tasks);
    const batchChars = requestChars(input);
    if (batchChars > REQUEST_LIMIT) {
      const middle = Math.ceil(tasks.length / 2);
      await verifyBatch(tasks.slice(0, middle));
      await verifyBatch(tasks.slice(middle));
      return;
    }
    checkRequest(input);
    maxRequestChars = Math.max(maxRequestChars, batchChars);
    verificationRequests++;
    let raw: unknown;
    try {
      raw = await model.generate(input);
    } catch (error) {
      if (!splitVerificationBatch(error)) throw error;
      const middle = Math.ceil(tasks.length / 2);
      await verifyBatch(tasks.slice(0, middle));
      await verifyBatch(tasks.slice(middle));
      return;
    }
    let validated: Array<{
      task: VerificationTask;
      value: { candidate: Candidate; verified: VerificationValue; citations: Citation[] };
    }>;
    try {
      const parsed = schema.parse(raw);
      const byTaskId = new Map(parsed.results.map((result) => [result.taskId, result]));
      if (
        byTaskId.size !== tasks.length ||
        tasks.some((task) => !byTaskId.has(task.taskId))
      )
        throw invalidOutput();
      validated = tasks.map((task) => {
        const result = byTaskId.get(task.taskId);
        if (!result) throw invalidOutput();
        const { taskId: _taskId, ...candidateResult } = result;
        const citationMapping = batchCitationMappings.get(task.taskId);
        if (!citationMapping) throw invalidOutput();
        candidateResult.citationIds = candidateResult.citationIds.map(
          (batchId) => {
            const originalId = citationMapping.get(batchId);
            if (!originalId) throw invalidOutput();
            return originalId;
          },
        );
        return {
          task,
          value: validateVerification(task, candidateResult),
        };
      });
    } catch (error) {
      if (!(error instanceof z.ZodError) && !splitVerificationBatch(error))
        throw error;
      const middle = Math.ceil(tasks.length / 2);
      await verifyBatch(tasks.slice(0, middle));
      await verifyBatch(tasks.slice(middle));
      return;
    }
    for (const { task, value } of validated)
      await completeVerification(task, value, true);
  }
  async function processCandidates(indices: number[]) {
    const tasks = await Promise.all(indices.map(buildVerificationTask));
    const cachedValues = await Promise.all(tasks.map((task) => cache.get(task.key)));
    const missing: VerificationTask[] = [];
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex];
      const cached = cachedValues[taskIndex];
      if (cached !== null) {
        await completeVerification(
          task,
          validateVerification(task, cached),
          false,
        );
      } else if (task.inputChars > REQUEST_LIMIT) {
        const value = validateVerification(task, {
          decision: "unconfirmed",
          reason:
            "La evidencia citada excede el límite de contexto para verificación; se conserva como no confirmada.",
          citationIds: [],
        });
        await completeVerification(task, value, true);
      } else {
        missing.push(task);
      }
    }
    for (let offset = 0; offset < missing.length; offset += 4) {
      await verifyBatch(missing.slice(offset, offset + 4));
    }
  }
  let nextCandidate = verificationCursor;
  let verificationFailed = false;
  let verificationFailure: unknown;
  async function visitCandidates() {
    while (!verificationFailed && nextCandidate < reviewCandidates.length) {
      const indices: number[] = [];
      while (indices.length < 4 && nextCandidate < reviewCandidates.length)
        indices.push(nextCandidate++);
      try {
        await processCandidates(indices);
      } catch (error) {
        if (!verificationFailed) {
          verificationFailed = true;
          verificationFailure = error;
        }
      }
    }
  }
  // Complete all started verification and cache writes before yielding. The
  // result arrays are filled by index so completion timing cannot reorder them.
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          verificationConcurrency,
          Math.ceil(reviewCandidates.length / 4),
        ),
      },
      visitCandidates,
    ),
  );
  if (verificationFailed) {
    await verificationProgressWrites.catch(() => undefined);
    throw verificationFailure;
  }
  let nextCachedPrefix = 0;
  async function reloadCachedVerificationPrefix() {
    while (nextCachedPrefix < resumeVerificationPrefix) {
      const index = nextCachedPrefix++;
      const task = await buildVerificationTask(index);
      const cached = await cache.get(task.key);
      if (cached === null) throw invalidOutput();
      verificationResults[index] = validateVerification(task, cached);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(64, resumeVerificationPrefix) },
      reloadCachedVerificationPrefix,
    ),
  );
  for (const { candidate, verified, citations } of verificationResults) {
    if (verified.decision === "amendment")
      amendments.push({
        previous: verified.previous!,
        replacement: verified.replacement!,
        reason: verified.reason,
        citations,
      });
    candidateReviews.push({
      left: candidate.left,
      right: candidate.right,
      decision: verified.decision,
      reason: verified.reason,
      citations,
    });
    if (verified.decision === "conflict")
      conflicts.push(
        `Conflicto verificado entre requisitos: ${verified.reason}`,
      );
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
    throw new DossierError("REPORT_CAPACITY_LIMIT", 413);
  return result;
}
