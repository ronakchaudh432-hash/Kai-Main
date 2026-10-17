// Stage 4 — Source Fetcher (diagram: Source Fetcher, HTTP/HTML).
// Downloads the actual result pages (bounded, parallel, best-effort) so
// answers ground in page content, not just search snippets.
// Security: SSRF-guarded — only public http(s) hosts, DNS-resolved and
// checked against private ranges; PDFs/binaries skipped (no heavy deps).

import { lookup } from "node:dns/promises";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
  if (v.startsWith("fe80")) return true; // link local
  if (v.startsWith("ff")) return true; // multicast
  return false;
}

/** Pure hostname pre-check (no DNS): blocks localhost-style names. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^[\d.]+$/.test(h)) return isPrivateIPv4(h);
  if (h.includes(":")) return isPrivateIPv6(h);
  return false;
}

async function hostResolvesPrivate(hostname: string): Promise<boolean> {
  try {
    const addrs = await lookup(hostname, { all: true });
    if (addrs.length === 0) return true;
    return addrs.some((a) =>
      a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address)
    );
  } catch {
    return true; // unresolvable → don't fetch
  }
}

/** Fetch one page's HTML. Returns null on any failure, non-HTML, or guard trip.
 *  Redirects are followed manually (max 3) with EVERY hop re-validated —
 *  a redirect to localhost/private space is a classic SSRF bypass. */
export async function fetchPageHtml(rawUrl: string): Promise<string | null> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isBlockedHost(url.hostname)) return null;
    if (await hostResolvesPrivate(url.hostname)) return null;
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "manual",
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop === MAX_REDIRECTS) return null;
      try {
        current = new URL(loc, url.toString()).toString();
      } catch {
        return null;
      }
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!res.ok || !res.body) return null;
    const ctype = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ctype)) return null; // skip PDFs/binaries
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks);
    return buf.toString("utf8");
  }
  return null;
}

/** Fetch top pages in parallel; returns html per URL (missing = failed). */
export async function fetchTopPages(urls: string[], maxPages: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const targets = urls.slice(0, Math.max(0, maxPages));
  const settled = await Promise.allSettled(targets.map((u) => fetchPageHtml(u)));
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) out.set(targets[i], r.value);
  });
  return out;
}
