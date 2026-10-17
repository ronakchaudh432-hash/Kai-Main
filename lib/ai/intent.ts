// Fast heuristic intent understanding + request classification.
// Runs synchronously (no LLM call) so simple questions stay fast; the
// orchestrator upgrades to deeper planning only for complex requests.

export type IntentCategory =
  | "casual"
  | "general_knowledge"
  | "current_info"
  | "research"
  | "coding"
  | "writing"
  | "mathematics"
  | "planning"
  | "decision_support"
  | "assistant_task"
  | "memory_request"
  | "multi_step"
  | "tool_task"
  | "playful"
  | "ambiguous";

export interface Intent {
  category: IntentCategory;
  needsWeb: boolean;
  needsMemory: boolean;
  needsTools: boolean;
  isComplex: boolean;
  /** True when the topic itself (festival, movie, rates…) mandates live verification. */
  mandatorySearch: boolean;
  subTasks: string[];
  expectedLength: "short" | "medium" | "long";
  language: string;
  confidence: number;
}

const RESEARCH_RE = /(research|latest|current|today'?s|this week|news|price|prices|richest|market\s*cap|new\s*(features?|release|update)|weather|score|scores|stock|version|release|update|who won|election|launch|announc)/i;
const TIME_SENSITIVE_RE = /(today|yesterday|tomorrow|this week|this month|20\d{2}|latest|current|now|recent|upcoming|what'?s new|price|share price|share market|nifty|sensex|banknifty|bank nifty|net\s*worth|how much.*worth|richest|market\s*cap|exchange\s*rate|forex|rankings?|standings|box\s*office|\bceo\b|prime minister|president of|gold|silver|bitcoin|ethereum|crypto|stock\s*(price|market|doing)|valuation|funding|\bipo\b|\bgdp\b|inflation|unemployment|weather|news)/i;
const CODE_RE = /(code|function|bug|error|debug|python|javascript|typescript|react|sql|api|regex|script|program|compile|deploy|git)/i;
const MATH_RE = /(^|\s)(\d[\d\s+\-*/().%^×÷]*=|\d+\s*[+\-*/%^×÷]\s*\d+|calculate|compute|solve|equation|integral|derivative|percentage of|sqrt|log of)/i;
const MEMORY_RE = /(remember|don't forget|do not forget|my favorite|my favourite|i prefer|i like|i dislike|i hate|whenever i|always|my name is|i am a|i work|keep in mind|note that|forget that|what do you (know|remember) about me|my preferences)/i;
const CASUAL_RE = /^(hi|hey|hello|yo|hola|namaste|good (morning|afternoon|evening|night)|how are you|what'?s up|thanks|thank you|bye|ok|okay|cool|nice|haha|lmao)\b/i;
const HINGLISH_RE = /\b(kya|kaise|kaisa|tum|aap|main|mein|hai|nahi|nahin|accha|achha|bhai|yaar|matlab|kaam|kaise ho|kya haal)\b/i;
const MULTI_RE = /( and then |, then | first .* then | step by step|compare .* and |pros and cons|plan .* trip|1[.)]\s+\S+[\s\S]{0,40}2[.)]\s)/i;
const WRITING_RE = /(write|draft|essay|email|letter|blog|story|poem|caption|thumbnail|bio|resume|cover letter|rewrite|paraphrase|summar)/i;
const DECISION_RE = /(should i|which (is|one) (is )?(better|best|worth)|recommend|suggest|advice|decide|choose between|pros and cons|worth (it|buying))/i;
// Section 6A mandatory-search topics: answered from training data these go
// stale/wrong (lunar dates shift yearly, collections change daily). Detection
// is by TOPIC, not phrasing — "when is Diwali" searches without "latest".
const FESTIVAL_RE = /diwali|deepavali|\bholi\b|navratri|dussehra|dusshera|ganesh\s*(chaturthi|otsav)?|ganpati|janmashtami|raksha\s*bandhan|\brakhi\b|\beid\b|ramadan|ramzan|bakrid|muharram|vaisakhi|baisakhi|pongal|\bonam\b|sankranti|karva\s*chauth|chhath|\bteej\b|shivratri|durga\s*puja|kali\s*puja|saraswati\s*puja|pitru\s*paksha|easter|good\s*friday|navroz|gurpurab|buddha\s*purnima|tyohar|teohar|festival\s*(date|dates|when|kab|calendar)/i;
const MOVIE_RE = /box\s*office|boxoffice|collection|profit|budget|\bgross\b|trailer|web\s*series|release\s*date|movie\s*(collection|release|review|cast)|film\s*(collection|release|festival)|review\s*(movie|film)|upcoming\s*(movie|film|series|season)|new\s*season|season\s*\d+|\bott\b/i;
const CELEB_RE = /(how many|number of|count of)\s*(subscribers?|followers?)|(subscribers?|followers?)\s*(count|million|billion)|net\s*worth|controversy|recent\s*(upload|video|song|album|post)|dating\s*(rumors|rumours|life)|breakup|richest|billionaire|youtuber/i;
const TECH_RE = /(new|latest)\s+(ai\s+)?models?|ai\s*(model|launch|release|update|news|pricing)|gpt[-\s]?\d|Muse\s*\d|gemini\s*\d|llama\s*\d|deepseek|qwen\d?|kimi|openai\s*(news|launch|release|update|price)|anthropic\s*(news|launch|release)|iphone\s*1[6-9]|galaxy\s*s2[5-9]|pixel\s*(9|10)|startup\s*(funding|news|launch)|funding\s*round|series\s*[abc]\s*(funding|round)|acquisition|acquired\s*by/i;
const SPORTS_NEWS_RE = /\bipl\b|world\s*cup|olympics|fifa|live\s*score|match\s*(score|today|live|schedule)|tournament|grand\s*prix|\bf1\b|medal\s*tally|\bwar\b|earthquake|flood|budget\s*20\d{2}/i;
const MANDATORY_RE = new RegExp(
  [FESTIVAL_RE, MOVIE_RE, CELEB_RE, TECH_RE, SPORTS_NEWS_RE].map((r) => r.source).join("|"),
  "i"
);
const PLAY_RE = /(guess\s+(who|what)|riddle|paheli|bujo\s+to|bet\s+you\s+can'?t|dare\s+you|let'?s\s+play|play\s+a\s+game|truth\s+or\s+dare|would\s+you\s+rather|roast\s+me|tell\s+me\s+a\s+joke|make\s+me\s+laugh)/i;
const AMBIGUOUS_RE = /^(it|that|this|do it|yes|no|okay\??|why\??|how\??|what\??)$/i;

function splitSubTasks(text: string): string[] {
  const parts = text
    .split(/(?: and then |, then |;\s*|\n+-\s*|\n+\d+[.)]\s*)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
  if (parts.length > 1 && text.length > 80) return parts.slice(0, 8);
  // "Compare X, tell me Y, check Z" style comma lists
  const commas = text.split(/,(?![^()]*\))/).map((s) => s.trim()).filter((s) => s.length > 10);
  if (commas.length >= 3 && /(compare|tell|check|give|list|explain)/i.test(text)) {
    return commas.slice(0, 8);
  }
  return [];
}

function detectLanguage(text: string): string {
  if (HINGLISH_RE.test(text)) return "hinglish";
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  return "english";
}

export function classifyIntent(message: string, historyLength = 0): Intent {
  const text = message.trim();
  const lower = text.toLowerCase();
  const subTasks = splitSubTasks(text);
  const language = detectLanguage(lower);

  let category: IntentCategory = "general_knowledge";
  let confidence = 0.6;

  if (CASUAL_RE.test(text) && text.length < 60) {
    category = "casual";
    confidence = 0.9;
  } else if (PLAY_RE.test(lower)) {
    category = "playful";
    confidence = 0.8;
  } else if (MEMORY_RE.test(lower)) {
    category = "memory_request";
    confidence = 0.85;
  } else if (MATH_RE.test(lower) && text.length < 120 && !RESEARCH_RE.test(lower)) {
    category = "mathematics";
    confidence = 0.8;
  } else if (CODE_RE.test(lower) && !(RESEARCH_RE.test(lower) || TIME_SENSITIVE_RE.test(lower))) {
    // Pure coding question. If it ALSO asks for latest/current info
    // ("latest React version"), realtime wins — docs/versions change.
    category = "coding";
    confidence = 0.75;
  } else if (MANDATORY_RE.test(lower)) {
    // Topic mandates live verification regardless of phrasing (Sec 6A)
    category = /(deep|thorough|research|compare|analy[sz]e|report|vs\.?|versus)/i.test(lower)
      ? "research"
      : "current_info";
    confidence = 0.85;
  } else if (subTasks.length >= 2 || MULTI_RE.test(lower)) {
    category = "multi_step";
    confidence = 0.8;
  } else if (RESEARCH_RE.test(lower) || TIME_SENSITIVE_RE.test(lower)) {
    category = TIME_SENSITIVE_RE.test(lower) && /(deep|thorough|research|compare|analy[sz]e|report)/i.test(lower)
      ? "research"
      : "current_info";
    confidence = 0.8;
  } else if (WRITING_RE.test(lower)) {
    category = "writing";
    confidence = 0.75;
  } else if (DECISION_RE.test(lower)) {
    category = "decision_support";
    confidence = 0.7;
  } else if (/(plan|schedule|organize|itinerary|roadmap|steps to)/i.test(lower)) {
    category = "planning";
    confidence = 0.7;
  } else if (/(remind|todo|to-?do|email|book|order|set a|schedule a)/i.test(lower)) {
    category = "assistant_task";
    confidence = 0.65;
  } else if (AMBIGUOUS_RE.test(lower) || (text.length < 12 && historyLength === 0)) {
    category = "ambiguous";
    confidence = 0.6;
  }

  if (category === "general_knowledge" && /(calculate|convert|weather|search|browse)/i.test(lower)) {
    category = "tool_task";
  }

  const needsWeb = category === "current_info" || category === "research";
  const mandatorySearch = MANDATORY_RE.test(lower) && needsWeb;
  const needsMemory =
    category === "memory_request" ||
    category === "playful" || // guesses land better with context (owner, projects, running jokes)
    /(prefer|favorite|favourite|my |i like|i work|project|channel|always|usually)/i.test(lower);
  const needsTools = category === "mathematics" || category === "tool_task" || needsWeb;
  const isComplex = category === "multi_step" || category === "research" || subTasks.length >= 2;

  const expectedLength: Intent["expectedLength"] =
    category === "casual" || text.length < 40 ? "short"
    : isComplex || category === "research" || category === "writing" || category === "coding"
      ? "long"
      : "medium";

  return { category, needsWeb, needsMemory, needsTools, isComplex, mandatorySearch, subTasks, expectedLength, language, confidence };
}

/** Detects correction feedback ("wrong", "still wrong", "galat hai") — short,
 *  directed at the previous answer. "What is wrong with X" is NOT this. */
export function isCorrection(text: string): boolean {  const t = text.trim();
  if (t.length > 80) return false;
  if (/^what(\u2019|')?s\s+wrong\b/i.test(t) || /^what\s+is\s+wrong\b/i.test(t)) return false;
  return /wrong|incorrect|not\s+(right|correct|true)|galat|sahi\s+nahi|theek\s+nahi|\bnope\b/i.test(t);
}

/** Box-office / financial-figure questions need the FINANCE evidence rules
 *  (gross ≠ net ≠ profit, identity check, reported-vs-calculated). */
export function looksLikeFinance(text: string): boolean {
  return /box\s*office|boxoffice|collection|profit|budget|\bgross\b|\bnet\b.*collection|distributor\s*share|opening\s*(day|weekend)|lifetime\s*collection/i.test(
    text
  );
}
