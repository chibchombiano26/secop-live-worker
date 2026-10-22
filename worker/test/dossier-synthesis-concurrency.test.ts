import { describe, it, expect } from "vitest";
import { extractRequirements } from "../src/dossier/synthesis";
import type { EvidenceChunk } from "../src/dossier/extraction";
import { DossierError } from "../src/dossier/contracts";
const chunks: EvidenceChunk[] = Array.from({ length: 12 }, (_, i) => ({
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
  it("splits truncated inference without losing source text or original page citations and caches the split for resume", async () => {
    const source = { ...chunks[0], page: 74, text: "BEGIN " + "dense requirement ".repeat(80) + " END" };
    const values = new Map<string, unknown>();
    const cache = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: unknown) => { values.set(key, value); },
    };
    const visited: EvidenceChunk[] = [];
    const model = { id: "test", generate: async (input: any) => {
      const chunk = input.evidence[0] as EvidenceChunk;
      visited.push(chunk);
      if (chunk.text.length > 1000) throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
      return part(chunk);
    } };
    const result = await extractRequirements([source], model, cache);
    expect(visited).toHaveLength(3);
    const sections = visited.slice(1);
    expect(sections[0].text.startsWith("BEGIN")).toBe(true);
    expect(sections[1].text.endsWith("END")).toBe(true);
    expect(sections[0].text + sections[1].text.slice(200)).toBe(source.text);
    expect(result.requirements).toHaveLength(2);
    expect(result.requirements.every(r => r.citations[0].page === 74 && source.text.includes(r.citations[0].excerpt))).toBe(true);
    visited.length = 0;
    expect(await extractRequirements([source], model, cache)).toEqual(result);
    expect(visited).toHaveLength(0);
  });
  it("fails explicitly when a minimal fragment still truncates rather than publishing partial requirements", async () => {
    await expect(extractRequirements([chunks[0]], { id: "test", generate: async () => {
      throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
    } })).rejects.toMatchObject({ code: "MODEL_OUTPUT_TRUNCATED" });
  });
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
  it("analyzes independent source fragments concurrently with at most eight calls and preserves original source order", async () => {
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
        await delay((13 - chunk.page!) * 3);
        active--;
        return part(chunk);
      },
    });
    expect(maximum).toBe(8);
    expect(visited.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(result.requirements.map((r) => r.citations[0].page)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
  it("settles in-flight results before yielding and resumes cached fragments without losing pages", async () => {
    const cached = new Map<string, unknown>();
    const resumableChunks: EvidenceChunk[] = Array.from({ length: 24 }, (_, i) => ({
      documentVersionId: "long-tender",
      page: i + 1,
      index: i,
      text: `Requirement on source page ${i + 1}.`,
    }));
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
    const options = { concurrency: 16 };
    await expect(
      extractRequirements(resumableChunks, model, cache, options),
    ).rejects.toThrow("temporary model interruption");
    expect(cached.size).toBe(15);
    failing = false;
    visited.length = 0;
    const result = await extractRequirements(
      resumableChunks,
      model,
      cache,
      options,
    );
    expect(result.requirements.map((r) => r.citations[0].page)).toEqual([
      ...resumableChunks.map((chunk) => chunk.page),
    ]);
    for (const chunk of resumableChunks.slice(1, 16))
      expect(visited).not.toContain(chunk.page);
    expect(visited).toContain(1);
    expect(visited).toContain(17);
  });

  it("caps concurrent nested truncation work at sixteen and retains every source page", async () => {
    const denseChunks: EvidenceChunk[] = Array.from({ length: 24 }, (_, i) => ({
      documentVersionId: "dense-tender",
      page: i + 1,
      index: i,
      text: `Page ${i + 1}: ${"dense requirement text ".repeat(90)}`,
    }));
    let active = 0;
    let maximum = 0;
    const result = await extractRequirements(
      denseChunks,
      {
        id: "test",
        generate: async (input) => {
          const chunk = input.evidence[0] as EvidenceChunk;
          active++;
          maximum = Math.max(maximum, active);
          await delay(1);
          active--;
          if (chunk.text.length > 500)
            throw new DossierError("MODEL_OUTPUT_TRUNCATED", 502, true);
          return { summary: String(chunk.page), conflicts: [], requirements: [] };
        },
      },
      undefined,
      { concurrency: 16 },
    );

    expect(maximum).toBeLessThanOrEqual(16);
    expect(new Set(result.summaries)).toEqual(
      new Set(denseChunks.map((chunk) => String(chunk.page))),
    );
  });
});
