export const runtime = "nodejs";

import { clearMemories, deleteMemory, listMemories, saveMemory } from "@/lib/memory/store";

export async function GET(): Promise<Response> {
  return Response.json({ memories: listMemories("default") });
}

export async function POST(req: Request): Promise<Response> {
  let body: { content?: string; category?: string; importance?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.content?.trim()) return Response.json({ error: "content is required." }, { status: 400 });
  const m = saveMemory({
    content: body.content.trim(),
    category: body.category ?? "other",
    importance: body.importance ?? 0.7,
  });
  return Response.json({ memory: m }, { status: 201 });
}

export async function DELETE(): Promise<Response> {
  const n = clearMemories("default");
  return Response.json({ ok: true, cleared: n });
}

export async function PATCH(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "id is required." }, { status: 400 });
  const ok = deleteMemory(id, "default");
  return Response.json({ ok });
}
