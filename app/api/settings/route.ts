export const runtime = "nodejs";

import { getSetting, setSetting } from "@/lib/database/db";

const ALLOWED = new Set(["memory_enabled", "pref_answer_style", "pref_tone"]);

export async function GET(): Promise<Response> {
  const settings: Record<string, string> = {};
  for (const k of ALLOWED) settings[k] = getSetting(k, k === "memory_enabled" ? "1" : "");
  return Response.json({ settings });
}

export async function PATCH(req: Request): Promise<Response> {
  let body: Record<string, string>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED.has(k)) continue;
    setSetting(k, String(v).slice(0, 2000));
  }
  return Response.json({ ok: true });
}
