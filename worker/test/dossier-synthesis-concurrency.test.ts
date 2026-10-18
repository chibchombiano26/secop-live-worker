import { describe, it, expect } from "vitest";
import { extractRequirements } from "../src/dossier/synthesis";
import type { EvidenceChunk } from "../src/dossier/extraction";
const chunks: EvidenceChunk[] = Array.from({ length: 8 }, (_, i) => ({
  documentVersionId: "long-tender",
  page: i + 1,
  index: i,
  text: `Original requirement on source page ${i + 1}.`,
}));
const part = (chunk: EvidenceChunk) => ({
  summary: chunk.text,
  conflicts: [],
  requirements: [
    {
      wording: chunk.text,
      category: "documents",
      mandatory: true,
      lot: null,
      deadline: null,
      rule: null,
      citations: [
        {
          documentVersionId: chunk.documentVersionId,
          page: chunk.page,
          excerpt: chunk.text,
        },
      ],
    },
  ],
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
describe("bounded complete dossier extraction", () => {
  it("coalesces identical source fragments without additional model charges", async () => {
    const values = new Map<string, unknown>();
    const cache = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    };
    let calls = 0;
    const result = await extractRequirements(
      [chunks[0], chunks[0], chunks[0]],
      {
        id: "test",
        generate: async () => {
          calls++;
          await delay(10);
          return part(chunks[0]);
        },
      },
      cache,
    );
    expect(calls).toBe(1);
    expect(result.requirements).toHaveLength(3);
    expect(values.size).toBe(1);
  });
  it("analyzes independent source fragments concurrently with at most three calls and preserves original source order", async () => {
    let active = 0,
      maximum = 0;
    const visited: number[] = [];
    const result = await extractRequirements(chunks, {
      id: "test",
      generate: async (input) => {
        const chunk = input.evidence[0] as EvidenceChunk;
        active++;
        maximum = Math.max(maximum, active);
        visited.push(chunk.page!);
        await delay((9 - chunk.page!) * 3);
        active--;
        return part(chunk);
      },
    });
    expect(maximum).toBe(3);
    expect(visited.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.requirements.map((r) => r.citations[0].page)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
  it("settles in-flight results before yielding and resumes cached fragments without losing pages", async () => {
    const cached = new Map<string, unknown>();
    const cache = {
      get: async (k: string) => cached.get(k) ?? null,
      put: async (k: string, v: unknown) => {
        cached.set(k, v);
      },
    };
    let failing = true;
    const visited: number[] = [];
    const model = {
      id: "test",
      generate: async (input: any) => {
        const chunk = input.evidence[0] as EvidenceChunk;
        visited.push(chunk.page!);
        if (failing && chunk.page === 1) {
          await delay(1);
          throw new Error("temporary model interruption");
        }
        await delay(10);
        return part(chunk);
      },
    };
    await expect(extractRequirements(chunks, model, cache)).rejects.toThrow(
      "temporary model interruption",
    );
    expect(cached.size).toBe(2);
    failing = false;
    visited.length = 0;
    const result = await extractRequirements(chunks, model, cache);
    expect(result.requirements.map((r) => r.citations[0].page)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(visited).not.toContain(2);
    expect(visited).not.toContain(3);
  });
});
