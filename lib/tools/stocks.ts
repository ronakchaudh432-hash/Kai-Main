// Free live market-data lane: Yahoo Finance chart API.
// No key, JSON, worldwide (US, NSE/BSE, global indices, forex, crypto,
// commodities). Used as the structured first stop for price/quote questions;
// unknown symbols fall through to web research (never fabricated).
//
// Premium lane: Marketstack (MARKETSTACK_API_KEY) serves EOD stock quotes for
// US + NSE/BSE listings and is tried FIRST for covered symbols; everything
// else (indices, forex, crypto, commodities) stays on the free Yahoo lane.

import { config } from "@/lib/config";

export interface StockEntry {
  label: string;
  symbols: string[]; // candidates in preference order, first valid wins
}

export interface Quote {
  symbol: string;
  label: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  /** True when change is measured vs the session open (EOD record has no prev close). */
  vsOpen: boolean;
  currency: string;
  exchange: string;
  asOf: string;
  live: boolean;
  url: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Company/index/commodity name → Yahoo symbols. Ordered matching is
// longest-key-first at query time (see extractStockQuery).
const NAME_MAP: Array<{ keys: string[]; symbols: string[]; label: string }> = [
  // US megacaps
  { keys: ["apple"], symbols: ["AAPL"], label: "Apple" },
  { keys: ["tesla"], symbols: ["TSLA"], label: "Tesla" },
  { keys: ["alphabet", "google"], symbols: ["GOOGL"], label: "Alphabet (Google)" },
  { keys: ["microsoft"], symbols: ["MSFT"], label: "Microsoft" },
  { keys: ["amazon"], symbols: ["AMZN"], label: "Amazon" },
  { keys: ["meta", "facebook"], symbols: ["META"], label: "Meta" },
  { keys: ["nvidia"], symbols: ["NVDA"], label: "NVIDIA" },
  { keys: ["netflix"], symbols: ["NFLX"], label: "Netflix" },
  { keys: ["palantir"], symbols: ["PLTR"], label: "Palantir" },
  { keys: ["coinbase"], symbols: ["COIN"], label: "Coinbase" },
  { keys: ["oracle"], symbols: ["ORCL"], label: "Oracle" },
  { keys: ["adobe"], symbols: ["ADBE"], label: "Adobe" },
  { keys: ["salesforce"], symbols: ["CRM"], label: "Salesforce" },
  { keys: ["amd", "advanced micro"], symbols: ["AMD"], label: "AMD" },
  { keys: ["intel"], symbols: ["INTC"], label: "Intel" },
  { keys: ["ibm"], symbols: ["IBM"], label: "IBM" },
  { keys: ["paypal"], symbols: ["PYPL"], label: "PayPal" },
  { keys: ["shopify"], symbols: ["SHOP"], label: "Shopify" },
  // India (NSE)
  { keys: ["reliance"], symbols: ["RELIANCE.NS"], label: "Reliance Industries" },
  { keys: ["tata consultancy", "tcs"], symbols: ["TCS.NS"], label: "TCS" },
  { keys: ["infosys", "infy"], symbols: ["INFY.NS"], label: "Infosys" },
  { keys: ["hdfc bank", "hdfcbank"], symbols: ["HDFCBANK.NS"], label: "HDFC Bank" },
  { keys: ["icici"], symbols: ["ICICIBANK.NS"], label: "ICICI Bank" },
  { keys: ["state bank", "sbi"], symbols: ["SBIN.NS"], label: "SBI" },
  { keys: ["tata motors"], symbols: ["TATAMOTORS.NS"], label: "Tata Motors" },
  { keys: ["asian paints"], symbols: ["ASIANPAINT.NS"], label: "Asian Paints" },
  { keys: ["bajaj finance"], symbols: ["BAJFINANCE.NS"], label: "Bajaj Finance" },
  { keys: ["sun pharma", "sunpharma"], symbols: ["SUNPHARMA.NS"], label: "Sun Pharma" },
  { keys: ["tech mahindra"], symbols: ["TECHM.NS"], label: "Tech Mahindra" },
  { keys: ["axis bank"], symbols: ["AXISBANK.NS"], label: "Axis Bank" },
  { keys: ["kotak"], symbols: ["KOTAKBANK.NS"], label: "Kotak Bank" },
  { keys: ["larsen", "l&t", "l and t"], symbols: ["LT.NS"], label: "L&T" },
  { keys: ["titan"], symbols: ["TITAN.NS"], label: "Titan" },
  { keys: ["maruti"], symbols: ["MARUTI.NS"], label: "Maruti Suzuki" },
  { keys: ["hcl"], symbols: ["HCLTECH.NS"], label: "HCLTech" },
  { keys: ["wipro"], symbols: ["WIPRO.NS"], label: "Wipro" },
  { keys: ["itc"], symbols: ["ITC.NS"], label: "ITC" },
  { keys: ["lic"], symbols: ["LICI.NS"], label: "LIC India" },
  { keys: ["paytm"], symbols: ["PAYTM.NS"], label: "Paytm" },
  { keys: ["zomato", "eternal"], symbols: ["ETERNAL.NS", "ZOMATO.NS"], label: "Eternal (Zomato)" },
  // Indices
  { keys: ["bank nifty", "banknifty", "nifty bank"], symbols: ["^NSEBANK"], label: "Nifty Bank" },
  { keys: ["nifty", "nifty 50"], symbols: ["^NSEI"], label: "Nifty 50" },
  { keys: ["sensex", "bse sensex"], symbols: ["^BSESN"], label: "BSE Sensex" },
  { keys: ["nasdaq"], symbols: ["^IXIC"], label: "Nasdaq" },
  { keys: ["s&p", "s&p 500", "sp500", "s and p"], symbols: ["^GSPC"], label: "S&P 500" },
  { keys: ["dow", "dow jones"], symbols: ["^DJI"], label: "Dow Jones" },
  { keys: ["ftse"], symbols: ["^FTSE"], label: "FTSE 100" },
  { keys: ["dax"], symbols: ["^GDAXI"], label: "DAX" },
  { keys: ["nikkei"], symbols: ["^N225"], label: "Nikkei 225" },
  { keys: ["hang seng", "hangseng"], symbols: ["^HSI"], label: "Hang Seng" },
  // Commodities / FX / crypto
  { keys: ["gold"], symbols: ["GC=F"], label: "Gold futures" },
  { keys: ["silver"], symbols: ["SI=F"], label: "Silver futures" },
  { keys: ["brent"], symbols: ["BZ=F"], label: "Brent crude" },
  { keys: ["crude", "wti", "oil price", "oil"], symbols: ["CL=F"], label: "WTI crude" },
  { keys: ["bitcoin", "btc"], symbols: ["BTC-USD"], label: "Bitcoin" },
  { keys: ["ethereum", "eth"], symbols: ["ETH-USD"], label: "Ethereum" },
  { keys: ["usd to inr", "usd/inr", "dollar rate", "dollar to rupee", "usd inr"], symbols: ["USDINR=X"], label: "USD/INR" },
  { keys: ["eur to usd", "eur/usd", "euro rate"], symbols: ["EURUSD=X"], label: "EUR/USD" },
];

const US_TICKERS = new Set(
  "aapl tsla googl goog msft amzn meta nvda nflx amd intc pltr coin orcl adbe crm ibm pypl shop".split(" ")
);

const GATE_RE =
  /stock|share|nifty|sensex|banknifty|nasdaq|dow|s&p|gold|silver|crude|oil|bitcoin|btc|ethereum|eth|forex|exchange\s*rate|usd|eur|inr|gbp|price|rate|quote|trading|worth|how much|\$[a-z]/i;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Detect quote intent and resolve to symbol entries (max 3). Null = not a market query. */
export function extractStockQuery(text: string): StockEntry[] | null {
  if (!GATE_RE.test(text)) return null;
  const lower = ` ${text.toLowerCase()} `;
  const found: StockEntry[] = [];
  const seen = new Set<string>();
  // Longest keys first so "hdfc bank" beats "bank", "tata motors" beats "motors".
  const entries = [...NAME_MAP].sort(
    (a, b) => Math.max(...b.keys.map((k) => k.length)) - Math.max(...a.keys.map((k) => k.length))
  );
  for (const e of entries) {
    if (e.keys.some((k) => new RegExp(`\\b${esc(k)}\\b`).test(lower))) {
      const id = e.symbols[0];
      if (!seen.has(id)) {
        seen.add(id);
        found.push(e);
      }
    }
    if (found.length >= 3) break;
  }
  // $TICKER and bare known US tickers ($XXX tries a US listing; Yahoo validates)
  const dollars = text.match(/\$([A-Za-z]{1,6})\b/g) ?? [];
  for (const d of dollars) {
    const sym = d.slice(1).toUpperCase();
    if (!seen.has(sym)) {
      seen.add(sym);
      found.push({ label: sym, symbols: [sym] });
    }
    if (found.length >= 3) break;
  }
  for (const t of lower.match(/\b[a-z]{2,5}\b/g) ?? []) {
    if (US_TICKERS.has(t) && !seen.has(t.toUpperCase())) {
      seen.add(t.toUpperCase());
      found.push({ label: t.toUpperCase(), symbols: [t.toUpperCase()] });
    }
    if (found.length >= 3) break;
  }
  return found.length > 0 ? found : null;
}

interface YahooResult {
  symbol: string;
  price: number;
  prevClose: number;
  currency: string;
  exchange: string;
  time: number;
  live: boolean;
}

async function fetchYahoo(symbol: string): Promise<YahooResult | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      {
        signal: AbortSignal.timeout(12_000),
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            currency?: string;
            exchangeName?: string;
            regularMarketPrice?: number;
            regularMarketTime?: number;
            chartPreviousClose?: number;
            previousClose?: number;
          };
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const r = json.chart?.result?.[0];
    const meta = r?.meta;
    if (!meta) return null;
    const closes = (r?.indicators?.quote?.[0]?.close ?? []).filter(
      (x): x is number => typeof x === "number" && Number.isFinite(x)
    );
    const lastClose = closes[closes.length - 1];
    const price =
      typeof meta.regularMarketPrice === "number" && Number.isFinite(meta.regularMarketPrice)
        ? meta.regularMarketPrice
        : lastClose;
    if (typeof price !== "number" || !Number.isFinite(price)) return null;
    const prev =
      (typeof meta.chartPreviousClose === "number" ? meta.chartPreviousClose : undefined) ??
      (typeof meta.previousClose === "number" ? meta.previousClose : undefined) ??
      closes[closes.length - 2] ??
      price;
    return {
      symbol,
      price,
      prevClose: prev,
      currency: meta.currency ?? "USD",
      exchange: meta.exchangeName ?? "",
      time: meta.regularMarketTime ?? r?.timestamp?.[r.timestamp.length - 1] ?? Math.floor(Date.now() / 1000),
      live: typeof meta.regularMarketPrice === "number",
    };
  } catch {
    return null;
  }
}

/** Fetch candidate symbols; first valid quote per entry wins. */
export async function fetchQuotes(entries: StockEntry[]): Promise<Quote[]> {
  const out: Quote[] = [];
  for (const e of entries.slice(0, 3)) {
    for (const sym of e.symbols) {
      const r = await fetchYahoo(sym);
      if (r) {
        const change = r.price - r.prevClose;
        const d = new Date(r.time * 1000);
        let asOf: string;
        try {
          asOf = new Intl.DateTimeFormat("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "UTC",
          }).format(d);
        } catch {
          asOf = d.toISOString().slice(0, 10);
        }
        out.push({
          symbol: sym,
          label: e.label,
          price: r.price,
          prevClose: r.prevClose,
          change,
          changePct: r.prevClose ? (change / r.prevClose) * 100 : 0,
          vsOpen: false,
          currency: r.currency,
          exchange: r.exchange,
          asOf,
          live: r.live,
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`,
        });
        break;
      }
    }
  }
  return out;
}

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: n < 10 ? 4 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  }
}

export function formatQuotes(quotes: Quote[]): string {
  return quotes
    .map((q) => {
      const sign = q.change >= 0 ? "+" : "";
      const move = q.vsOpen ? "vs open" : "on the day";
      const link = q.url ? ` ${q.url}` : "";
      return (
        `${q.label} (${q.symbol}${q.exchange ? ` · ${q.exchange}` : ""}) — ${money(q.price, q.currency)} ` +
        `(${sign}${money(q.change, q.currency)}, ${sign}${q.changePct.toFixed(2)}% ${move}), ` +
        `${q.live ? "live" : "last close"} as of ${q.asOf} (UTC).${link}`
      );
    })
    .join("\n");
}

/** Map a Yahoo-style symbol to Marketstack (US + NSE/BSE stocks only).
 *  Returns null for indices (^...), forex (=X), crypto (-USD), futures (=F). */
export function toMarketstackSymbol(yahooSym: string): string | null {
  const s = yahooSym.trim().toUpperCase();
  if (s.endsWith(".NS")) return `${s.slice(0, -3)}.XNSE`;
  if (s.endsWith(".BO")) return `${s.slice(0, -3)}.XBOM`;
  if (/^[A-Z][A-Z0-9.]{0,7}$/.test(s) && !s.includes("^") && !s.includes("=") && !s.includes("-")) {
    return s;
  }
  return null;
}

interface MarketstackBar {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  symbol?: string;
  exchange?: string;
  date?: string;
}

/** Premium lane: Marketstack EOD latest for covered stock entries. Entries
 *  with no convertible symbol are skipped (caller tries Yahoo for those). */
export async function fetchMarketstackQuotes(entries: StockEntry[]): Promise<Quote[]> {
  const key = config.marketstackKey;
  if (!key) return [];
  const wanted: Array<{ entry: StockEntry; ms: string }> = [];
  for (const e of entries.slice(0, 3)) {
    for (const sym of e.symbols) {
      const ms = toMarketstackSymbol(sym);
      if (ms) {
        wanted.push({ entry: e, ms });
        break;
      }
    }
  }
  if (wanted.length === 0) return [];
  try {
    const res = await fetch(
      `https://api.marketstack.com/v1/eod/latest?access_key=${encodeURIComponent(key)}&symbols=${wanted.map((w) => encodeURIComponent(w.ms)).join(",")}`,
      { signal: AbortSignal.timeout(12_000) }
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: MarketstackBar[] };
    const bySymbol = new Map<string, MarketstackBar>();
    for (const bar of json.data ?? []) {
      if (bar?.symbol && typeof bar.close === "number") bySymbol.set(bar.symbol.toUpperCase(), bar);
    }
    const out: Quote[] = [];
    for (const w of wanted) {
      const bar = bySymbol.get(w.ms.toUpperCase());
      if (!bar || typeof bar.close !== "number" || !Number.isFinite(bar.close)) continue;
      const open = typeof bar.open === "number" ? bar.open : bar.close;
      const change = bar.close - open;
      const currency = /XNSE|XBOM/.test(w.ms) ? "INR" : "USD";
      let asOf = "";
      try {
        asOf = new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(bar.date ?? Date.now()));
      } catch {
        asOf = String(bar.date ?? "").slice(0, 10);
      }
      out.push({
        symbol: w.ms,
        label: w.entry.label,
        price: bar.close,
        prevClose: open,
        change,
        changePct: open ? (change / open) * 100 : 0,
        vsOpen: true,
        currency,
        exchange: bar.exchange ?? "",
        asOf,
        live: false,
        url: "",
      });
    }
    return out;
  } catch {
    return [];
  }
}
