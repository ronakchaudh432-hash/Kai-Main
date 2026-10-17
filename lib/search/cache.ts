// Stage 8 — WebCache (lightweight in-memory TTL cache, no new deps).
// Keyed by normalized query + depth. Successes only — failures are never
// cached (a failed lookup must not become a misleading "answer").
// TTL varies by freshness: breaking-type queries expire fast, stable ones slow.

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const MAX_ENTRIES = 100;

const DEFAULT_TTL_MS = 15 * 60_000;
const FRESH_TTL_MS = 5 * 60_000;

const FRESH_RE =
  /breaking|live|score|weather|stock|price|bitcoin|crypto|nifty|sensex|forex|election|match|today|right now/i;

function normalizeKey(query: string, depth: string): string {
  return `${depth}::${query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 300)}`;
}

export function ttlForQuery(query: string, configuredTtlMs?: number): number {
  if (typeof configuredTtlMs === "number" && configuredTtlMs > 0) return configuredTtlMs;
  return FRESH_RE.test(query) ? FRESH_TTL_MS : DEFAULT_TTL_MS;
}

export class TtlCache<T> {
  private map = new Map<string, CacheEntry<T>>();

  get(key: string): T | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return e.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export function researchCacheKey(query: string, depth: string): string {
  return normalizeKey(query, depth);
}
