export const runtime = "nodejs";

import {
  createConversation,
  deleteConversation,
  getMessages,
  listConversations,
  renameConversation,
  searchConversations,
} from "@/lib/database/db";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const convs = q ? searchConversations(q) : listConversations();
  // Attach a preview of the last message for the sidebar
  const withPreview = convs.map((c) => {
    try {
      const msgs = getMessages(c.id, 1_000_000);
      const last = msgs[msgs.length - 1];
      return { ...c, preview: last ? last.content.slice(0, 120) : "" };
    } catch {
      return { ...c, preview: "" };
    }
  });
  return Response.json({ conversations: withPreview });
}

export async function POST(): Promise<Response> {
  const conv = createConversation("New chat");
  return Response.json({ conversation: conv }, { status: 201 });
}

export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "id is required." }, { status: 400 });
  deleteConversation(id);
  return Response.json({ ok: true });
}

export async function PATCH(req: Request): Promise<Response> {
  let body: { id?: string; title?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.id || !body.title?.trim()) {
    return Response.json({ error: "id and title are required." }, { status: 400 });
  }
  renameConversation(body.id, body.title.trim());
  return Response.json({ ok: true });
}
