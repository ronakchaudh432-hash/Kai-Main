export const runtime = "nodejs";

import { deleteConversation, getConversation, getMessages, renameConversation } from "@/lib/database/db";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const conv = getConversation(id);
  if (!conv) return Response.json({ error: "Not found." }, { status: 404 });
  return Response.json({ conversation: conv, messages: getMessages(id) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  let body: { title?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.title?.trim()) return Response.json({ error: "title is required." }, { status: 400 });
  renameConversation(id, body.title.trim());
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  deleteConversation(id);
  return Response.json({ ok: true });
}
