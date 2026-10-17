// Central configuration. ASSISTANT_NAME and OWNER_NAME are the single source
// of truth for identity — never hard-code them in UI or prompts.

function readGroqKeys(): string[] {
  const keys: string[] = [];
  // Numbered keys: GROQ_API_KEY_1, GROQ_API_KEY_2, ... (dynamic count)
  for (let i = 1; i <= 64; i++) {
    const v = process.env[`GROQ_API_KEY_${i}`]?.trim();
    if (v) keys.push(v);
  }
  // Comma-separated alternative: GROQ_API_KEYS=k1,k2,k3
  const csv = process.env.GROQ_API_KEYS?.trim();
  if (csv) {
    for (const part of csv.split(",")) {
      const k = part.trim();
      if (k && !keys.includes(k)) keys.push(k);
    }
  }
  // Legacy single-key var still works
  const single = process.env.GROQ_API_KEY?.trim();
  if (single && !keys.includes(single)) keys.push(single);
  return keys;
}

export const config = {
  get assistantName(): string {
    return (process.env.ASSISTANT_NAME?.trim() || "CAI").toUpperCase();
  },
  get ownerName(): string {
    const raw = (process.env.OWNER_NAME?.trim() || "Owner").replace(/\s+/g, " ");
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  },
  get groqKeys(): string[] {
    return readGroqKeys();
  },
  get groqModel(): string {
    return process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
  },
  get sqlitePath(): string {
    return process.env.SQLITE_PATH?.trim() || "./data/cai.db";
  },
  /** Public URL of this deployment (used for provider attribution headers). */
  get appUrl(): string {
    return process.env.APP_URL?.trim().replace(/\/+$/, "") || "";
  },
  get tavilyKey(): string {
    return (
      process.env.TAVILY_API_KEY?.trim() || process.env.SEARCH_API_KEY?.trim() || ""
    );
  },
  get marketstackKey(): string {
    return process.env.MARKETSTACK_API_KEY?.trim() || "";
  },
  get openrouterKey(): string {
    return process.env.OPENROUTER_API_KEY?.trim() || "";
  },
  get openrouterModel(): string {
    return process.env.OPENROUTER_MODEL?.trim() || "nvidia/nemotron-3-super-120b-a12b:free";
  },
  get geminiKey(): string {
    return process.env.GEMINI_API_KEY?.trim() || "";
  },
  get geminiModel(): string {
    return process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";
  },
  /** Failover order across providers (comma-separated, unknown names ignored). */
  get providerOrder(): string[] {
    const raw = (process.env.AI_PROVIDER_ORDER ?? "groq,gemini,openrouter").trim();
    const known = new Set(["groq", "gemini", "openrouter"]);
    const order = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => known.has(s));
    return order.length > 0 ? [...new Set(order)] : ["groq"];
  },
  get searxngUrl(): string {
    return process.env.SEARXNG_URL?.trim().replace(/\/+$/, "") || "";
  },
  get webSearchEnabled(): boolean {
    const v = (process.env.WEB_SEARCH_ENABLED ?? "true").trim().toLowerCase();
    return v !== "0" && v !== "false" && v !== "no" && v !== "off";
  },
  get webCacheTtlMs(): number | undefined {
    const n = Number((process.env.WEB_CACHE_TTL_MS ?? "").trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
};
