// Stage 5 — Content Extractor (diagram: Content Extractor).
// HTML → clean text → query-relevant windows. Pure module, zero deps.

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(Number(n));
      } catch {
        return " ";
      }
    });
}

/** Strip boilerplate and tags → collapsed plain text (capped). */
export function htmlToText(html: string, maxChars = 8000): string {
  let s = html.slice(0, 200_000);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|nav|header|footer|aside|noscript|svg|form|iframe)[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, maxChars);
}

function queryTerms(query: string): string[] {
  const stop = new Set(
    "the,a,an,and,or,of,in,on,for,to,is,are,was,what,when,where,which,who,how,why,do,does,did,current,latest,today,now".split(",")
  );
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

/** Pick the sentences most relevant to the query, in original order. */
export function relevantWindows(text: string, query: string, maxChars = 1500): string {
  const terms = queryTerms(query);
  if (terms.length === 0 || !text) return text.slice(0, maxChars);
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  const scored = sentences
    .map((s, i) => {
      const low = s.toLowerCase();
      let hits = 0;
      for (const t of terms) if (low.includes(t)) hits++;
      return { s: s.trim(), i, hits };
    })
    .filter((x) => x.hits > 0 && x.s.length > 20)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .slice(0, 6)
    .sort((a, b) => a.i - b.i);
  const joined = scored.map((x) => x.s).join(" ");
  return (joined || text.slice(0, maxChars)).slice(0, maxChars);
}
