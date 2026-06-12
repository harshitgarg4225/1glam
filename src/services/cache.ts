// Tiny in-process TTL cache. Deliberately dependency-free and bounded.
//
// Why this exists: the app's datastore is Google Sheets, whose API allows
// ~60 reads/min per user. Without caching, every dashboard refresh, webhook,
// and scheduler tick re-reads whole sheets and the quota becomes the ceiling
// on how many artists the product can serve. Hot reads (workspace records,
// lead/booking sheet scans) go through here with short TTLs and explicit
// invalidation on every write, so reads stay fresh-enough while API usage
// drops by an order of magnitude.
//
// Single-instance semantics: entries live in process memory. With multiple
// instances each keeps its own cache; TTLs are kept short (seconds) so
// cross-instance staleness is bounded and writes-after-read race windows stay
// small. If the app outgrows one instance per region, swap the Map for Redis
// behind this same interface.

type Entry<T> = { value: T; expiresAt: number };

const MAX_ENTRIES = 2000; // hard bound so a workspace flood can't exhaust memory

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();

  constructor(private defaultTtlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.store.size >= MAX_ENTRIES && !this.store.has(key)) {
      // Evict the oldest insertion (Map preserves insertion order).
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Delete every key for which `predicate` returns true. */
  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of this.store.keys()) {
      if (predicate(key)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  /**
   * Read-through helper: returns the cached value or runs `loader`, caches the
   * result, and returns it. Concurrent callers for the same key share one
   * in-flight load (request coalescing), so a burst of dashboard refreshes
   * costs one Sheets read, not N.
   */
  async getOrLoad(key: string, loader: () => Promise<T>, ttlMs?: number): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const load = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, load);
    return load;
  }

  private inflight = new Map<string, Promise<T>>();
}
