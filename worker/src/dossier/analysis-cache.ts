import { DossierError } from "./contracts";
import type { DossierRepository } from "./repository";

const CACHE_READ_BATCH_SIZE = 80;
type CacheWaiter = {
  resolve: (value: unknown | null) => void;
  reject: (error: unknown) => void;
};

/**
 * Owner-scoped, demand-driven cache access. Extraction can preload a bounded
 * window of exact keys; other cache reads are coalesced into bounded batches.
 */
export class DossierAnalysisCache {
  private readonly values = new Map<string, unknown | null>();
  private readonly pending = new Map<string, CacheWaiter[]>();
  private scheduled = false;
  private flushing = false;

  constructor(private readonly repo: DossierRepository) {}

  async preload(ids: string[]) {
    const requested = [...new Set(ids)].filter((id) => !this.values.has(id));
    if (!requested.length) return;
    const records = await this.repo.readMany<unknown>("report", requested, {
      allowMissing: true,
      retryNetworkLoss: true,
    });
    for (const id of requested) this.values.set(id, null);
    for (const record of records) this.values.set(record.id, record.value);
  }

  release(ids: string[]) {
    for (const id of ids) this.values.delete(id);
  }

  get(id: string): Promise<unknown | null> {
    if (this.values.has(id))
      return Promise.resolve(this.values.get(id) ?? null);
    return new Promise((resolve, reject) => {
      const waiters = this.pending.get(id) ?? [];
      waiters.push({ resolve, reject });
      this.pending.set(id, waiters);
      if (!this.scheduled && !this.flushing) {
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  async put(id: string, value: unknown) {
    await this.repo.writeAnalysisCache(id, value);
    if (this.values.has(id)) this.values.set(id, value);
  }

  private async flush() {
    this.scheduled = false;
    this.flushing = true;
    const entries = [...this.pending.entries()].slice(0, CACHE_READ_BATCH_SIZE);
    for (const [id] of entries) this.pending.delete(id);
    try {
      if (entries.length) await this.resolveBatch(entries);
    } finally {
      this.flushing = false;
      if (this.pending.size && !this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    }
  }

  private async resolveBatch(
    entries: Array<[string, CacheWaiter[]]>,
  ) {
    try {
      const records = await this.repo.readMany<unknown>(
        "report",
        entries.map(([id]) => id),
        {
          allowMissing: true,
          retryNetworkLoss: true,
        },
      );
      const found = new Map(
        records.map((record) => [record.id, record.value]),
      );
      for (const [id, waiters] of entries)
        for (const waiter of waiters) waiter.resolve(found.get(id) ?? null);
    } catch (error) {
      if (
        error instanceof DossierError &&
        error.code === "CORPUS_CAPACITY_LIMIT" &&
        entries.length >= 2
      ) {
        const middle = Math.ceil(entries.length / 2);
        await this.resolveBatch(entries.slice(0, middle));
        await this.resolveBatch(entries.slice(middle));
        return;
      }
      for (const [, waiters] of entries)
        for (const waiter of waiters) waiter.reject(error);
    }
  }
}
