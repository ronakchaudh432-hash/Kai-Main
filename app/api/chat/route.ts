export const runtime = "nodejs";

import { orchestrate, type StreamEvent } from "@/lib/ai/orchestrator";
import { createConversation, getConversation } from "@/lib/database/db";

function encode(e: StreamEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

export async function POST(req: Request): Promise<Response> {
  let body: { message?: string; conversationId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const message = (body.message ?? "").toString().trim();
  if (!message) return Response.json({ error: "Message is required." }, { status: 400 });
  if (message.length > 20000) {
    return Response.json({ error: "Message is too long (max 20,000 characters)." }, { status: 400 });
  }

  let conversationId = (body.conversationId ?? "").toString();
  if (conversationId) {
    if (!getConversation(conversationId)) {
      return Response.json({ error: "Conversation not found." }, { status: 404 });
    }
  } else {
    conversationId = createConversation("New chat").id;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e: StreamEvent) => controller.enqueue(enc.encode(encode(e)));
      // Tell the client which conversation this belongs to first
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "conversation", id: conversationId })}\n\n`));
      try {
        await orchestrate(conversationId, message, {
          emit: send,
          signal: req.signal,
        });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? e.message : "Something went wrong.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
