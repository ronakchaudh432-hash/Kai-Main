// Safe arithmetic evaluator — no eval(). Supports + - * / % ^ ( ) and a
// small set of functions: sqrt, abs, floor, ceil, round, log, ln, sin, cos,
// tan, PI, E. Used directly for math intents (no LLM round-trip needed).

type Token =
  | { t: "num"; v: number }
  | { t: "op"; v: string }
  | { t: "fn"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "const"; v: number };

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  log: (x) => Math.log10(x),
  ln: Math.log,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const s = expr.replace(/×/g, "*").replace(/÷/g, "/").replace(/\^/g, "**").replace(/\s+/g, "");
  // normalize ** back to single ^ op
  const norm = s.replace(/\*\*/g, "^");
  while (i < norm.length) {
    const c = norm[i];
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < norm.length && /[0-9.]/.test(norm[j])) j++;
      const n = Number(norm.slice(i, j));
      if (!Number.isFinite(n)) return null;
      tokens.push({ t: "num", v: n });
      i = j;
    } else if (c === "(") {
      tokens.push({ t: "lp" });
      i++;
    } else if (c === ")") {
      tokens.push({ t: "rp" });
      i++;
    } else if ("+-*/%^".includes(c)) {
      // unary minus handling
      const prev = tokens[tokens.length - 1];
      if (c === "-" && (!prev || prev.t === "op" || prev.t === "lp")) {
        tokens.push({ t: "num", v: 0 });
      }
      tokens.push({ t: "op", v: c });
      i++;
    } else if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < norm.length && /[a-zA-Z]/.test(norm[j])) j++;
      const word = norm.slice(i, j).toLowerCase();
      if (word === "pi") tokens.push({ t: "const", v: Math.PI });
      else if (word === "e") tokens.push({ t: "const", v: Math.E });
      else if (FUNCTIONS[word]) tokens.push({ t: "fn", v: word });
      else if (word === "x") tokens.push({ t: "op", v: "*" });
      else return null;
      i = j;
    } else {
      return null;
    }
  }
  return tokens;
}

function toRpn(tokens: Token[]): Token[] | null {
  const out: Token[] = [];
  const stack: Token[] = [];
  const prec = (op: string) => (op === "+" || op === "-" ? 1 : op === "*" || op === "/" || op === "%" ? 2 : 3);
  for (const tok of tokens) {
    if (tok.t === "num" || tok.t === "const") out.push(tok);
    else if (tok.t === "fn") stack.push(tok);
    else if (tok.t === "op") {
      while (
        stack.length > 0 &&
        ((stack[stack.length - 1].t === "op" &&
          prec((stack[stack.length - 1] as { v: string }).v) >= prec(tok.v)) ||
          stack[stack.length - 1].t === "fn")
      ) {
        out.push(stack.pop()!);
      }
      stack.push(tok);
    } else if (tok.t === "lp") stack.push(tok);
    else if (tok.t === "rp") {
      let found = false;
      while (stack.length > 0) {
        const top = stack.pop()!;
        if (top.t === "lp") {
          found = true;
          break;
        }
        out.push(top);
      }
      if (!found) return null;
      if (stack.length > 0 && stack[stack.length - 1].t === "fn") out.push(stack.pop()!);
    }
  }
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top.t === "lp" || top.t === "rp") return null;
    out.push(top);
  }
  return out;
}

export function looksLikeMath(text: string): boolean {
  const cleaned = text
    .toLowerCase()
    .replace(/^(calculate|compute|solve|what is|what's|evaluate|how much is)/, "")
    .trim();
  return /^[0-9a-z\s+\-*/().%^×÷]*$/.test(cleaned) && /\d/.test(cleaned) && /[+\-*/%^×÷]/.test(cleaned);
}

export function extractExpression(text: string): string {
  let s = text.trim();
  s = s.replace(/^(please\s+)?(calculate|compute|solve|evaluate|what is|what's|how much is)\s+/i, "");
  s = s.replace(/\?$/, "").trim();
  // "15 % of 200" style
  const pct = s.match(/^([\d.]+)\s*%\s*of\s*([\d.]+)$/i);
  if (pct) return `(${pct[1]}/100)*(${pct[2]})`;
  return s;
}

export function calculate(expression: string): number {
  const tokens = tokenize(expression);
  if (!tokens) throw new Error("Could not parse expression");
  const rpn = toRpn(tokens);
  if (!rpn) throw new Error("Could not parse expression");
  const stack: number[] = [];
  for (const tok of rpn) {
    if (tok.t === "num" || tok.t === "const") stack.push(tok.v);
    else if (tok.t === "fn") {
      const a = stack.pop();
      if (a === undefined) throw new Error("Invalid expression");
      const r = FUNCTIONS[tok.v](a);
      if (!Number.isFinite(r)) throw new Error("Math error (e.g. sqrt of negative)");
      stack.push(r);
    } else if (tok.t === "op") {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new Error("Invalid expression");
      let r: number;
      switch (tok.v) {
        case "+": r = a + b; break;
        case "-": r = a - b; break;
        case "*": r = a * b; break;
        case "/":
          if (b === 0) throw new Error("Division by zero");
          r = a / b;
          break;
        case "%": r = a % b; break;
        case "^": r = Math.pow(a, b); break;
        default: throw new Error("Unknown operator");
      }
      if (!Number.isFinite(r)) throw new Error("Math error");
      stack.push(r);
    }
  }
  if (stack.length !== 1) throw new Error("Invalid expression");
  return stack[0];
}
