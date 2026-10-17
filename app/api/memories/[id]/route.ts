export const runtime = "nodejs";

import { deleteMemory, updateMemory } from "@/lib/memory/store";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  let body: { content?: string; category?: string; importance?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const ok = updateMemory(id, body);
  if (!ok) return Response.json({ error: "Not found or nothing to update." }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const ok = deleteMemory(id, "default");
  return Response.json({ ok });
}
