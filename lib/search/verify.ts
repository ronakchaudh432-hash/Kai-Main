// Stage 7 — Verification & Conflict Check (diagram).
// Compares extracted dates/figures across sources: agreement strengthens,
// disagreement is surfaced (never silently averaged). Pure module.

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

/** Find candidate factual claims: calendar dates + money figures ($ and ₹). */
function extractClaims(text: string): string[] {
  const out: string[] = [];
  const dateRe = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\s+(20\\d{2})\\b`, "gi");
  const moneyRe = /\$\s?[\d,]+(\.\d+)?\s?(billion|million|trillion|bn|mn)?/gi;
  const inrRe = /(?:₹|rs\.?|inr)\s?[\d,.]+\s?(crore|lakh|crores|lakhs|billion|million)?/gi;
  let m: RegExpExecArray | null;
  while ((m = dateRe.exec(text)) !== null && out.length < 12) {
    out.push(`date:${m[1]} ${m[2].toLowerCase()} ${m[3]}`);
  }
  while ((m = moneyRe.exec(text)) !== null && out.length < 24) {
    out.push(`money:${m[0].toLowerCase().replace(/\s+/g, "")}`);
  }
  while ((m = inrRe.exec(text)) !== null && out.length < 36) {
    out.push(`inr:${m[0].toLowerCase().replace(/\s+/g, "")}`);
  }
  return [...new Set(out)];
}

/**
 * Returns a verification note for the prompt: agreement ("2 sources agree…"),
 * conflict ("sources disagree: A says X, B says Y — state the range"), or "".
 */
export function checkConflicts(
  sources: Array<{ url: string; text: string }>
): string {
  const usable = sources.filter((s) => s.text && s.text.length > 25).slice(0, 6);
  if (usable.length === 0) return "";
  // claim -> hosts asserting it
  const claims = new Map<string, Set<string>>();
  for (const s of usable) {
    for (const c of extractClaims(s.text)) {
      if (!claims.has(c)) claims.set(c, new Set());
      claims.get(c)!.add(hostOf(s.url));
    }
  }
  if (claims.size === 0) return "";
  // Group by kind to detect distinct competing values.
  const byKind = new Map<string, Map<string, string[]>>();
  for (const [claim, hosts] of claims) {
    const kind = claim.split(":")[0];
    if (!byKind.has(kind)) byKind.set(kind, new Map());
    byKind.get(kind)!.set(claim, [...hosts]);
  }
  const notes: string[] = [];
  for (const [kind, values] of byKind) {
    if (values.size === 1) {
      const [claim, hosts] = [...values.entries()][0];
      if (hosts.length >= 2) {
        notes.push(
          `${kind} agreement: "${claim.slice(kind.length + 1)}" asserted by ${hosts.length} sources (${hosts.slice(0, 3).join(", ")}).`
        );
      }
    } else {
      const parts = [...values.entries()]
        .slice(0, 4)
        .map(([claim, hosts]) => `"${claim.slice(kind.length + 1)}" (${hosts.slice(0, 2).join(", ")})`);
      notes.push(
        `${kind} CONFLICT across sources: ${parts.join(" vs ")} — state the range with per-source attribution, do not pick one silently.`
      );
    }
  }
  if (notes.length === 0) return "";
  return `VERIFICATION (computed across tool-returned sources):\n` + notes.map((n) => `- ${n}`).join("\n");
}

/**
 * Bounded-escalation decision (Sec 34): exactly one extra round, only when
 * the evidence conflicts or is thin. Pure — unit-tested.
 */
export function shouldEscalate(
  sources: Array<unknown>,
  detail: string,
  roundsUsed: number
): boolean {
  if (roundsUsed >= 2) return false; // one escalation round max
  if (detail.includes("CONFLICT")) return true;
  return sources.length > 0 && sources.length < 3;
}
