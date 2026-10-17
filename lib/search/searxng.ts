// Stage 2a — SearXNG provider (diagram: SearXNG self-hosted).
// Optional: used only when SEARXNG_URL is configured, e.g.
//   SEARXNG_URL=http://localhost:8080   (docker run -d -p 8080:8080 searxng/searxng)
// Falls back to the built-in providers when unset or unreachable — the
// pipeline never depends on it.

import type { WebSource } from "@/lib/search/web";

export function searxngConfigured(baseUrl: string): boolean {
  return baseUrl.trim().length > 0;
}

export async function querySearxng(
  baseUrl: string,
  query: string,
  limit = 8
): Promise<WebSource[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: { "User-Agent": "CAI-assistant/1.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`searxng http ${res.status}`);
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; engines?: string[] }>;
  };
  return (json.results ?? [])
    .filter((r) => r.url && /^https?:\/\//.test(r.url))
    .slice(0, limit)
    .map((r, i) => ({
      title: (r.title ?? r.url ?? "source").slice(0, 140),
      url: r.url ?? "",
      snippet: (r.content ?? "").slice(0, 500),
      authority: 0.5,
      engine: r.engines?.[0],
      position: i + 1,
    }));
}
