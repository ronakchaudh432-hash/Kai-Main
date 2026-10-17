// Citation integrity (absolute requirement): every displayed source must be
// an actually-retrieved result. Evidence uses S1..Sn IDs; the model may cite
// ONLY those IDs. This module validates final text and sanitizes violations:
// unknown markdown-link URLs are demoted to plain text (link text kept).
// Bare URLs are left alone (they may be general-knowledge links, and the
// grounded-sources instruction already forbids inventing them as citations).

export interface CitationCheck {
  valid: boolean;
  /** Markdown links whose URL was not in the retrieved set (removed). */
  removed: string[];
  text: string;
}

function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString().toLowerCase().replace(/\/$/, "");
  } catch {
    return u.trim().toLowerCase();
  }
}

/** Validate [Sn] ids + markdown-link URLs against retrieved sources. */
export function validateCitations(
  text: string,
  sources: Array<{ url: string }>
): { valid: boolean; unknownIds: string[]; unknownUrls: string[] } {
  const known = new Set(sources.map((s) => normalizeUrl(s.url)));
  const n = sources.length;
  const unknownIds: string[] = [];
  for (const m of text.matchAll(/\[S(\d+)\]|【S(\d+)】|［S(\d+)］/g)) {
    const id = Number(m[1] ?? m[2] ?? m[3]);
    if (!Number.isInteger(id) || id < 1 || id > n) unknownIds.push(m[0]);
  }
  const unknownUrls: string[] = [];
  for (const m of text.matchAll(/\[[^\]]+\]\((https?:[^)\s]+)\)/g)) {
    if (!known.has(normalizeUrl(m[1]))) unknownUrls.push(m[1]);
  }
  return {
    valid: unknownIds.length === 0 && unknownUrls.length === 0,
    unknownIds: [...new Set(unknownIds)],
    unknownUrls: [...new Set(unknownUrls)],
  };
}

/** Sanitize: drop unknown markdown-link URLs to plain text; fix bad [Sn]. */
export function sanitizeCitations(
  text: string,
  sources: Array<{ url: string }>
): CitationCheck {
  const known = new Set(sources.map((s) => normalizeUrl(s.url)));
  const removed: string[] = [];
  let out = text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (full, label, url) => {
    if (known.has(normalizeUrl(url))) return full;
    removed.push(url);
    return String(label);
  });
  const n = sources.length;
  out = out.replace(/\[S(\d+)\]|【S(\d+)】|［S(\d+)］/g, (full, a, b, c) => {
    const id = Number(a ?? b ?? c);
    if (Number.isInteger(id) && id >= 1 && id <= n) return full;
    removed.push(full);
    return "";
  });
  return { valid: removed.length === 0, removed: [...new Set(removed)], text: out };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 32);
  }
}

/**
 * Render valid [Sn] ids as clickable markdown links (`[host](url)`), so users
 * NEVER see raw internal labels like "[S1][S2]". Run AFTER sanitizeCitations
 * (unknown ids are already removed there). Sources keep their evidence order.
 * Handles ASCII [S1] plus the full-width variants models sometimes emit.
 */
export function renderCitations(
  text: string,
  sources: Array<{ url: string }>
): string {
  const n = sources.length;
  if (n === 0) return text;
  return text.replace(/\[S(\d+)\]|【S(\d+)】|［S(\d+)］/g, (full, a, b, c) => {
    const id = Number(a ?? b ?? c);
    if (!Number.isInteger(id) || id < 1 || id > n) return "";
    const url = sources[id - 1].url;
    return `[${hostOf(url)}](${url})`;
  });
}
