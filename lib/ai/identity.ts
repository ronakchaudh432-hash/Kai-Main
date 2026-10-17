// Identity fast-path: creator/owner questions get a deterministic answer from
// config (OWNER_NAME), never from memory or model guesswork. This guarantees
// "who made you" always returns the owner, even when the AI backend is down.
// Pure module — no imports, easily unit-tested.

type Lang = "english" | "hinglish" | "hindi";

const HINGLISH_MARKERS =
  /\b(kya|kaise|kaisa|tum|tumhe|tumhara|aap|main|mein|mera|tera|hai|hain|nahi|nahin|kaun|kisne|banaya|banaaya|malik|bhai|yaar|boss|accha|achha|matlab|kaam|theek|bilkul|zaroor|arre|arey|batao|bata|kaise ho|kya haal)\b/i;

function detectLang(text: string): Lang {
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  if (HINGLISH_MARKERS.test(text)) return "hinglish";
  return "english";
}

const CREATOR_RE =
  /(who\s+(made|built|created|developed|designed|coded|invented|owns|own|is behind)\s+(you|u|this)|who('s| is)\s+(your|ur)\s+(creator|owner|boss|maker|master|father|dad|god|creator\??)|tumhe\s+kisne\s+banaya|tera\s+(malik|boss|owner)\s+kaun|kisne\s+(tumhe|tumko|aapko)\s+banaya|tumhara\s+(malik|boss|owner)\s+kaun|तुम्हें\s+किसने\s+बनाया|तुमको\s+किसने\s+बनाया|आपको\s+किसने\s+बनाया|किसने\s+(तुम्हें|तुमको|आपको)\s+बनाया|तुम्हारा\s+(मालिक|बॉस)\s+कौन|तुम्हारे\s+(मालिक|बॉस)\s+कौन)/i;

const SELF_RE =
  /^(who\s+are\s+you|what\s+are\s+you|introduce\s+yourself|apna\s+intro|tum\s+kaun\s+ho|aap\s+kaun\s+ho|tu\s+kaun\s+hai|तुम\s+कौन\s+हो|आप\s+कौन\s+हैं|तू\s+कौन\s+है)\??\s*$/i;

const COMPETITOR_RE =
  /(are\s+you\s+(chatgpt|gpt|openai|Muse|anthropic|gemini|google\s*(ai|bard)?|copilot|meta\s*ai|grok|xai)|r\s*u\s+(chatgpt|gpt|openai|Muse|gemini)|kya\s+tum\s+(chatgpt|gpt|openai|Muse|gemini)\s+ho)/i;

const ENGINE_RE =
  /(what|which)\s+(model|llm|engine)\s+.*(((you|u)\s+(use|runs?|powers?|powered|built on))|((uses?|runs?|powers?|powered)\s+(you|u)))|powered\s+by|under\s+the\s+hood|tech(nical)?\s+(stack|architecture)|groq|tum\s+kaunse\s+model\s+par/i;

export type IdentityKind = "creator" | "self" | "competitor" | "engine" | null;

export function classifyIdentity(text: string): IdentityKind {
  const t = text.trim();
  if (t.length > 300) return null;
  if (ENGINE_RE.test(t) && !CREATOR_RE.test(t)) return "engine";
  if (COMPETITOR_RE.test(t)) return "competitor";
  if (SELF_RE.test(t)) return "self";
  if (CREATOR_RE.test(t)) return "creator";
  return null;
}

const EN_CREATOR = [
  "That'd be {owner} — they built me from scratch. I'm {name}, their personal AI.",
  "I'm {name}, made by {owner}. They run the show, I just make them look good.",
  "{owner} created me — I'm their personal AI, {name}. Fully on their side, always.",
];

const EN_SELF = [
  "I'm {name}, {owner}'s personal AI — part helper, part friend, fully on their side.",
];

const EN_COMPETITOR = [
  "Nope, I'm {name} — built by {owner}. Different family entirely, bro.",
  "Not even close. I'm {name}, {owner}'s own creation.",
];

const HI_CREATOR = [
  "मुझे {owner} ने बनाया है — मैं {name} हूँ, उनका personal AI assistant।",
  "{owner} मेरे creator हैं, boss — मैं {name} हूँ, हमेशा उनकी तरफ।",
];

const HI_SELF = ["मैं {name} हूँ, {owner} का personal AI — दोस्त भी, helper भी।"];

const HI_COMPETITOR = ["नहीं भाई, मैं {name} हूँ — मुझे {owner} ने बनाया है।"];

const HING_CREATOR = [
  "Mujhe {owner} ne banaya hai, boss — main {name} hoon, unka personal AI.",
  "{owner}! Unhone mujhe banaya hai. Main {name} — unka AI dost, hamesha unki side.",
];

const HING_SELF = ["Main {name} hoon, {owner} ka personal AI — kaam ka bhi, dost bhi."];

const HING_COMPETITOR = ["Nahi bhai, main {name} hoon — mujhe {owner} ne banaya hai."];

function fill(template: string, name: string, owner: string): string {
  return template.replaceAll("{name}", name).replaceAll("{owner}", owner);
}

/** Deterministic identity answer, or null when this isn't an identity question. */
export function answerIdentityQuestion(
  text: string,
  assistantName: string,
  ownerName: string,
  modelId = ""
): string | null {
  const kind = classifyIdentity(text);
  if (!kind) return null;
  const lang = detectLang(text);
  const pick = <T>(arr: T[]): T => arr[text.trim().length % arr.length];

  if (kind === "engine") {
    const engine =
      lang === "hindi"
        ? `Under the hood main Groq ke fast inference par chalta hoon${modelId ? ` (${modelId})` : ""} — lekin banaya mujhe ${ownerName} ne hai, boss wahi hai.`
        : lang === "hinglish"
          ? `Under the hood I run on Groq's fast inference${modelId ? ` (${modelId})` : ""} — but ${ownerName} built me, and they're the one I answer to, bro.`
          : `Under the hood I run on Groq's fast inference${modelId ? ` (${modelId})` : ""} — but ${ownerName} built me, and they're the one I answer to.`;
    return engine;
  }

  if (lang === "hindi") {
    if (kind === "competitor") return fill(pick(HI_COMPETITOR), assistantName, ownerName);
    if (kind === "self") return fill(pick(HI_SELF), assistantName, ownerName);
    return fill(pick(HI_CREATOR), assistantName, ownerName);
  }
  if (lang === "hinglish") {
    if (kind === "competitor") return fill(pick(HING_COMPETITOR), assistantName, ownerName);
    if (kind === "self") return fill(pick(HING_SELF), assistantName, ownerName);
    return fill(pick(HING_CREATOR), assistantName, ownerName);
  }
  if (kind === "competitor") return fill(pick(EN_COMPETITOR), assistantName, ownerName);
  if (kind === "self") return fill(pick(EN_SELF), assistantName, ownerName);
  return fill(pick(EN_CREATOR), assistantName, ownerName);
}
