// Multi-key Groq routing pool: live concurrent load distribution with
// health tracking, exponential-backoff cooldowns, and pluggable strategies.
// Keys are server-side only — key ids exposed here are opaque ("key_1").

export type RoutingStrategy =
  | "round-robin"
  | "least-recently-used"
  | "health-based"
  | "least-used"
  | "adaptive";

export type KeyHealth = "healthy" | "cooling-down" | "disabled";

export interface KeySlot {
  id: string; // opaque id, e.g. "key_1" — never the raw key
  key: string; // raw material, server-side only
  health: KeyHealth;
  requestCount: number;
  errorCount: number;
  tokenEstimate: number;
  lastUsedAt: number; // epoch ms, 0 = never
  cooldownUntil: number; // epoch ms
  consecutiveFailures: number;
}

export interface KeyStatus {
  id: string;
  health: KeyHealth;
  requestCount: number;
  errorCount: number;
  lastUsedAt: number;
  cooldownMsRemaining: number;
}

const BASE_COOLDOWN_MS = 15_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

function fingerprint(key: string, index: number): string {
  // Opaque id derived from position + a short hash of the tail (no raw material)
  let h = 0;
  const tail = key.slice(-8);
  for (let i = 0; i < tail.length; i++) h = (h * 31 + tail.charCodeAt(i)) >>> 0;
  return `key_${index + 1}_${h.toString(36)}`;
}

class GroqKeyPool {
  private slots: KeySlot[] = [];
  private cursor = 0;
  private strategy: RoutingStrategy = "adaptive";
  private initializedWith: string[] = [];

  /** (Re)initialize from the current env key list. Preserves health stats. */
  configure(rawKeys: string[], strategy: RoutingStrategy = "adaptive"): void {
    this.strategy = strategy;
    const seen = new Set<string>();
    const next: KeySlot[] = [];
    rawKeys.forEach((key, i) => {
      if (!key || seen.has(key)) return;
      seen.add(key);
      const id = fingerprint(key, i);
      const prev = this.slots.find((s) => s.key === key);
      next.push(
        prev ?? {
          id,
          key,
          health: "healthy",
          requestCount: 0,
          errorCount: 0,
          tokenEstimate: 0,
          lastUsedAt: 0,
          cooldownUntil: 0,
          consecutiveFailures: 0,
        }
      );
    });
    this.slots = next;
    this.initializedWith = [...rawKeys];
    if (this.cursor >= this.slots.length) this.cursor = 0;
  }

  get size(): number {
    return this.slots.length;
  }

  setStrategy(s: RoutingStrategy): void {
    this.strategy = s;
  }

  private isUsable(s: KeySlot, now: number): boolean {
    if (s.health === "disabled") return false;
    if (s.health === "cooling-down" && now < s.cooldownUntil) return false;
    return true;
  }

  /** Pick a slot for the next request. True concurrency: independent calls
   *  get different healthy keys (round-robin / load-aware), never a single lane. */
  acquire(): KeySlot | null {
    const now = Date.now();
    // Auto-restore expired cooldowns
    for (const s of this.slots) {
      if (s.health === "cooling-down" && now >= s.cooldownUntil) {
        s.health = "healthy";
      }
    }
    let candidates = this.slots.filter((s) => this.isUsable(s, now));
    if (candidates.length === 0) {
      // All cooling down: use the one whose cooldown expires soonest rather
      // than failing outright (caller still retries with backoff on 429).
      const waiting = [...this.slots].sort((a, b) => a.cooldownUntil - b.cooldownUntil);
      const first = waiting[0];
      if (!first) return null;
      candidates = [first];
    }
    switch (this.strategy) {
      case "least-recently-used":
        return candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      case "least-used":
        return candidates.sort((a, b) => a.tokenEstimate - b.tokenEstimate)[0];
      case "health-based":
        return candidates.sort(
          (a, b) =>
            a.consecutiveFailures - b.consecutiveFailures || a.requestCount - b.requestCount
        )[0];
      case "round-robin": {
        const slot = candidates[this.cursor % candidates.length];
        this.cursor += 1;
        return slot;
      }
      case "adaptive":
      default: {
        // Health-aware round-robin favoring least-loaded healthy keys
        const sorted = [...candidates].sort(
          (a, b) =>
            a.consecutiveFailures - b.consecutiveFailures ||
            a.requestCount - b.requestCount ||
            a.lastUsedAt - b.lastUsedAt
        );
        const top = sorted.slice(0, Math.max(1, Math.min(3, sorted.length)));
        const slot = top[this.cursor % top.length];
        this.cursor += 1;
        return slot;
      }
    }
  }

  markSuccess(slot: KeySlot, tokenEstimate = 0): void {
    slot.requestCount += 1;
    slot.lastUsedAt = Date.now();
    slot.tokenEstimate += tokenEstimate;
    slot.consecutiveFailures = 0;
    if (slot.health === "cooling-down" && Date.now() >= slot.cooldownUntil) {
      slot.health = "healthy";
    }
  }

  /** Returns the cooldown applied (ms). 401/403 disables; 429/5xx backs off. */
  markFailure(slot: KeySlot, status: number): number {
    slot.errorCount += 1;
    slot.consecutiveFailures += 1;
    const now = Date.now();
    if (status === 401 || status === 403) {
      slot.health = "disabled";
      slot.cooldownUntil = Number.POSITIVE_INFINITY;
      return Number.POSITIVE_INFINITY;
    }
    const backoff = Math.min(
      BASE_COOLDOWN_MS * 2 ** Math.min(slot.consecutiveFailures - 1, 5),
      MAX_COOLDOWN_MS
    );
    slot.health = "cooling-down";
    slot.cooldownUntil = now + backoff;
    return backoff;
  }

  /** Opaque statuses safe to expose to admin UI (no raw keys). */
  statuses(): KeyStatus[] {
    const now = Date.now();
    return this.slots.map((s) => ({
      id: s.id,
      health: s.health === "cooling-down" && now >= s.cooldownUntil ? "healthy" : s.health,
      requestCount: s.requestCount,
      errorCount: s.errorCount,
      lastUsedAt: s.lastUsedAt,
      cooldownMsRemaining:
        s.health === "cooling-down" ? Math.max(0, s.cooldownUntil - now) : 0,
    }));
  }
}

export const groqKeyPool = new GroqKeyPool();
export const __poolInternals = { fingerprint };
