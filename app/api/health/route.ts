export const runtime = "nodejs";

// Admin/dev key-health panel data — opaque ids + counters only. Raw keys are
// NEVER exposed here or anywhere client-reachable.
import { groqKeyPool } from "@/lib/ai/keyPool";
import { config } from "@/lib/config";

export async function GET(): Promise<Response> {
  groqKeyPool.configure(config.groqKeys);
  return Response.json({
    assistant: config.assistantName,
    model: config.groqModel,
    keysConfigured: groqKeyPool.size,
    keys: groqKeyPool.statuses(),
    // Search provider status (config only — no live probing, no secrets).
    search: {
      enabled: config.webSearchEnabled,
      primary: config.searxngUrl
        ? "searxng"
        : config.tavilyKey
          ? "tavily"
          : "duckduckgo+wikipedia",
      searxngConfigured: config.searxngUrl.length > 0,
      marketstackConfigured: config.marketstackKey.length > 0,
    },
  });
}
