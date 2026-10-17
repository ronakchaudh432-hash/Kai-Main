"use client";

// Main CAI client: conversations, streaming chat, memories, settings.
// Backend states (thinking/searching/processing/writing) drive the mascot —
// no fake indicators: the mascot only shows what the server actually reports.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Mascot, type MascotState } from "@/components/Mascot";
import { MessageBody } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { Sidebar, type ConvItem } from "@/components/Sidebar";

interface Msg {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata?: string | null;
  sources?: Array<{ title: string; url: string }>;
  /** False when research ran but live verification failed (show indicator). */
  researchOk?: boolean;
}

/** Attach persisted research metadata (sources + verification flag) to messages. */
function attachMeta<T extends { metadata?: string | null }>(msgs: T[]): T[] {
  return msgs.map((m) => {
    if (!m.metadata || typeof m.metadata !== "string") return m;
    try {
      const meta = JSON.parse(m.metadata) as {
        sources?: Array<{ title: string; url: string }>;
        researchOk?: boolean;
      };
      return {
        ...m,
        sources: Array.isArray(meta.sources) ? meta.sources.slice(0, 5) : undefined,
        researchOk: typeof meta.researchOk === "boolean" ? meta.researchOk : undefined,
      };
    } catch {
      return m;
    }
  });
}

interface MemoryItem {
  id: string;
  content: string;
  category: string;
  importance: number;
  updated_at: string;
}

const FALLBACK_NAME = "CAI";

type Phase = "idle" | "thinking" | "searching" | "processing" | "writing" | "error";

/** Short domain label for source chips (never exposes full tracking URLs). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 32);
  }
}

function phaseToMascot(phase: Phase, streaming: boolean): MascotState {  if (streaming) return "RESPONDING";
  switch (phase) {
    case "thinking": return "THINKING";
    case "searching": return "SEARCHING";
    case "processing": return "PROCESSING";
    case "writing": return "RESPONDING";
    case "error": return "ERROR";
    default: return "IDLE";
  }
}
const StreamingBubble = React.memo(function StreamingBubble({ text, mascotState, assistantName }: { text: string; mascotState: MascotState; assistantName: string }) {
  if (!text) return null;
  return (
    <div className="row asst-row">
      <div className="avatar">
        <Mascot state={mascotState} assistantName={assistantName} size={32} />
      </div>
      <div className="bubble asst">
        <MessageBody content={text} />
        <span className="caret" aria-hidden="true">▍</span>
      </div>
    </div>
  );
});

function timeGreeting(name: string): string {
  const h = new Date().getHours();
  if (h < 5) return `Late night? I'm ${name} — what's on your mind?`;
  if (h < 12) return `Good morning! I'm ${name} — how can I help?`;
  if (h < 17) return `Hey! I'm ${name} — what are we working on?`;
  if (h < 21) return `Good evening! I'm ${name} — how can I help?`;
  return `Hey, I'm ${name} — what's up?`;
}

export function Chat() {
  const [conversations, setConversations] = useState<ConvItem[]>([]);
  const [assistantName, setAssistantName] = useState(FALLBACK_NAME);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [phaseLabel, setPhaseLabel] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [keyHealth, setKeyHealth] = useState<{ model: string; keysConfigured: number; keys: Array<{ id: string; health: string; requestCount: number; errorCount: number }> } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastScrollRef = useRef(0);
  const sendingRef = useRef(false);

  const scrollBottom = useCallback(() => {
    const now = Date.now();
    if (now - lastScrollRef.current < 200) return;
    lastScrollRef.current = now;
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
  }, []);

  const refreshList = useCallback(async (q = "") => {
    try {
      const res = await fetch(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      const json = await res.json();
      setConversations(json.conversations ?? []);
    } catch {
      /* offline — keep current list */
    }
  }, []);

  const openConversation = useCallback(async (id: string) => {
    try {
      setLoading(true);
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) return;
      const json = await res.json();
      setActiveId(id);
      setMessages(attachMeta((json.messages ?? []).filter((m: Msg) => m.role !== "system")));
      setPhase("idle");
      setPhaseLabel("");
      setStreamingText("");
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  const handleQuery = useCallback((q: string) => {
    setQuery(q);
    refreshList(q);
  }, [refreshList]);

  useEffect(() => {
    // Initial load: assistant name (single server-side source of truth),
    // list, then open the most recent (or stay on welcome)
    (async () => {
      try {
        const h = await fetch("/api/health");
        if (h.ok) {
          const hj = await h.json();
          if (typeof hj.assistant === "string" && hj.assistant.trim()) {
            setAssistantName(hj.assistant.trim().toUpperCase());
          }
        }
      } catch {
        /* keep fallback */
      }
      try {
        const res = await fetch("/api/conversations");
        const json = await res.json();
        const list: ConvItem[] = json.conversations ?? [];
        setConversations(list);
      } catch {
        /* ignore */
      }
    })();
  }, [openConversation]);

  useEffect(() => {
    scrollBottom();
  }, [messages, streamingText, scrollBottom]);

  const send = useCallback(async (text: string, targetId?: string, historyOverride?: Msg[]) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    const convId = targetId ?? activeId;
    const base = historyOverride ?? messages;
    // Optimistic user bubble
    const optimistic: Msg = { id: `local_${Date.now()}`, role: "user", content: text };
    setMessages([...base, optimistic]);
    setStreamingText("");
    setPhase("thinking");
    setPhaseLabel("Thinking…");
    scrollBottom();

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let acc = "";
    let finalConvId: string | null = convId;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversationId: convId }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.type === "conversation") {
            finalConvId = evt.id;
            setActiveId(evt.id);
          } else if (evt.type === "state") {
            const s = evt.state as string;
            if (s === "thinking") { setPhase("thinking"); setPhaseLabel("Thinking…"); }
            else if (s === "searching") { setPhase("searching"); setPhaseLabel("Searching the web…"); }
            else if (s === "processing") { setPhase("processing"); setPhaseLabel("Working…"); }
            else if (s === "writing") { setPhase("writing"); setPhaseLabel("Writing…"); }
          } else if (evt.type === "token") {
            acc += evt.token as string;
            setStreamingText(acc);
            scrollBottom();
          } else if (evt.type === "done") {
            acc = evt.full as string;
            setStreamingText("");
            setMessages((prev) => [...prev, {
              id: `a_${Date.now()}`,
              role: "assistant",
              content: acc,
              sources: Array.isArray(evt.sources) ? evt.sources : undefined,
              researchOk: typeof evt.researchOk === "boolean" ? evt.researchOk : undefined,
            }]);
            setPhase("idle");
            setPhaseLabel("");
          } else if (evt.type === "error") {
            setPhase("error");
            setPhaseLabel(evt.message as string);
            setStreamingText("");
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        if (acc) {
          setMessages((prev) => [...prev, { id: `a_${Date.now()}`, role: "assistant", content: acc }]);
        }
        setStreamingText("");
        setPhase("idle");
        setPhaseLabel("");
      } else {
        setPhase("error");
        setPhaseLabel(e instanceof Error ? e.message : "Request failed.");
        setStreamingText("");
      }
    } finally {
      sendingRef.current = false;
      abortRef.current = null;
      refreshList(query);
      if (finalConvId) {
        // Re-sync authoritative history (titles, persisted ids)
        try {
          const r = await fetch(`/api/conversations/${finalConvId}`);
          if (r.ok) {
            const j = await r.json();
            setMessages(attachMeta((j.messages ?? []).filter((m: Msg) => m.role !== "system")));
          }
        } catch {
          /* keep optimistic */
        }
      }
    }
  }, [activeId, messages, query, refreshList, scrollBottom]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const newChat = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", { method: "POST" });
      const json = await res.json();
      setActiveId(json.conversation.id);
      setMessages([]);
      setPhase("idle");
      setPhaseLabel("");
      setStreamingText("");
      refreshList(query);
    } catch {
      /* ignore */
    }
  }, [query, refreshList]);

  const removeChat = useCallback(async (id: string) => {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (activeId === id) {
      setActiveId(null);
      setMessages([]);
    }
    refreshList(query);
  }, [activeId, query, refreshList]);

  const renameChat = useCallback(async (id: string, title: string) => {
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    refreshList(query);
  }, [query, refreshList]);

  const regenerate = useCallback(() => {
    const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
    if (lastUserIdx < 0 || !activeId) return;
    const lastUser = messages[lastUserIdx];
    // Drop everything from the last user message onward
    const kept = messages.slice(0, lastUserIdx);
    setMessages(kept);
    send(lastUser.content, activeId, kept);
  }, [messages, activeId, send]);

  const editAndResend = useCallback((id: string, content: string) => {
    if (!activeId) return;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const kept = messages.slice(0, idx);
    setMessages(kept);
    send(content, activeId, kept);
    setEditingId(null);
  }, [messages, activeId, send]);

  const openSettings = useCallback(async () => {
    setSettingsOpen(true);
    try {
      const [m, s, h] = await Promise.all([
        fetch("/api/memories").then((r) => r.json()),
        fetch("/api/settings").then((r) => r.json()),
        fetch("/api/health").then((r) => r.json()),
      ]);
      setMemories(m.memories ?? []);
      setMemoryEnabled((s.settings?.memory_enabled ?? "1") === "1");
      setKeyHealth(h);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleMemory = useCallback(async () => {
    const next = !memoryEnabled;
    setMemoryEnabled(next);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory_enabled: next ? "1" : "0" }),
    });
  }, [memoryEnabled]);

  const deleteMemory = useCallback(async (id: string) => {
    await fetch(`/api/memories/${id}`, { method: "DELETE" });
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const clearAllMemories = useCallback(async () => {
    if (!window.confirm("Delete all stored memories?")) return;
    await fetch("/api/memories", { method: "DELETE" });
    setMemories([]);
  }, []);

  const streaming = phase !== "idle" && phase !== "error";
  const mascotState = phase === "error" ? "ERROR" : phaseToMascot(phase, !!streamingText || phase === "writing");

  return (
    <div className="app-shell">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={openConversation}
        onNew={newChat}
        onDelete={removeChat}
        onRename={renameChat}
        query={query}
        onQuery={handleQuery}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        assistantName={assistantName}
      />
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            ☰
          </button>
          <span className="brand">{assistantName}</span>
          <div className="top-actions">
            <button className="icon-btn" onClick={newChat} aria-label="New chat">＋</button>
            <button className="icon-btn" onClick={openSettings} aria-label="Settings">⚙</button>
          </div>
        </header>

        <main className="thread" aria-live="polite">
          {loading ? (
            <div className="messages">
              {[1,2,3].map(i => <div key={i} className="row asst-row"><div className="skeleton-bubble" /></div>)}
            </div>
          ) : messages.length === 0 && !streamingText ? (
            <div className="empty">
              <Mascot state="IDLE" assistantName={assistantName} size={92} />
              <h1>{timeGreeting(assistantName)}</h1>
              <p className="empty-sub">Ask anything. I remember what matters, look things up when they&apos;re current, and keep it concise unless depth helps.</p>
              <div className="suggestions">
                {["Explain a tricky concept simply", "Help me write better code", "What's the latest in AI?", "Plan my week"].map((s) => (
                  <button key={s} onClick={() => send(s)} className="suggestion">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="row user-row">
                    <div className="bubble user">
                      {editingId === m.id ? (
                        <div className="edit-box">
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={3}
                            aria-label="Edit message"
                          />
                          <div className="edit-actions">
                            <button onClick={() => editAndResend(m.id, editText)} disabled={!editText.trim()}>Resend</button>
                            <button onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p>{m.content}</p>
                          <button
                            className="msg-edit"
                            onClick={() => { setEditingId(m.id); setEditText(m.content); }}
                            aria-label="Edit message"
                          >
                            Edit
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ) : m.role === "assistant" ? (
                  <div key={m.id} className="row asst-row">
                    <div className="avatar">
                      <Mascot state={streaming && m.id === messages[messages.length - 1]?.id ? mascotState : "IDLE"} assistantName={assistantName} size={32} />
                    </div>
                    <div className="bubble asst">
                      <MessageBody content={m.content} />
                      {m.sources && m.sources.length > 0 && (
                        <div className="sources" aria-label="Sources used">
                          <span className="sources-title">Sources</span>
                          {m.sources.map((s) => (
                            <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">
                              {hostOf(s.url)}
                            </a>
                          ))}
                        </div>
                      )}
                      {m.researchOk === false && (
                        <p className="unverified">Live verification unavailable for this answer.</p>
                      )}
                    </div>
                  </div>
                ) : null
              )}
              <StreamingBubble text={streamingText} mascotState={mascotState} assistantName={assistantName} />
              {streaming && !streamingText && (
                <div className="row asst-row">
                  <div className="avatar">
                    <Mascot state={mascotState} assistantName={assistantName} size={32} />
                  </div>
                  <div className="bubble asst status">
                    <span className="pulse" aria-hidden="true" />
                    {phaseLabel || "Working…"}
                  </div>
                </div>
              )}
              {phase === "error" && (
                <div className="row asst-row">
                  <div className="bubble asst error-bubble" role="alert">
                    {phaseLabel}
                    <div>
                      <button className="retry" onClick={regenerate}>Try again</button>
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </main>

        <footer className="composer-zone">
          {messages.length > 0 && (
            <div className="thread-actions">
              <button onClick={regenerate} disabled={streaming} aria-label="Regenerate response">↻ Regenerate</button>
              <button onClick={scrollBottom} aria-label="Scroll to bottom">↓ Latest</button>
            </div>
          )}
          <div className="composer-row">
            {messages.length > 0 && (
              <Mascot state={mascotState} assistantName={assistantName} size={44} />
            )}
            <Composer onSend={(t) => send(t)} onStop={stop} streaming={streaming} assistantName={assistantName} />
          </div>
          <p className="disclaimer">{assistantName} can make mistakes — verify important facts.</p>
        </footer>
      </div>

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Settings</h2>
              <button onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button>
            </div>
            <section>
              <h3>Memory</h3>
              <label className="toggle">
                <input type="checkbox" checked={memoryEnabled} onChange={toggleMemory} />
                Remember useful preferences across chats
              </label>
              <p className="hint">Only genuinely useful preferences are kept. Say &ldquo;forget that&rdquo; any time, or manage below.</p>
              <ul className="mem-list">
                {memories.map((m) => (
                  <li key={m.id}>
                    <span className="mem-cat">{m.category}</span>
                    <span className="mem-content">{m.content}</span>
                    <button onClick={() => deleteMemory(m.id)} aria-label={`Delete memory ${m.content.slice(0, 30)}`}>×</button>
                  </li>
                ))}
                {memories.length === 0 && <li className="mem-empty">No memories stored yet.</li>}
              </ul>
              {memories.length > 0 && (
                <button className="danger" onClick={clearAllMemories}>Clear all memories</button>
              )}
            </section>
            <section>
              <h3>Service health</h3>
              {keyHealth ? (
                <p className="hint">
                  {keyHealth.keysConfigured} key{keyHealth.keysConfigured === 1 ? "" : "s"} configured · model {keyHealth.model || "server-configured"}
                </p>
              ) : (
                <p className="hint">Loading…</p>
              )}
              <ul className="mem-list">
                {(keyHealth?.keys ?? []).map((k) => (
                  <li key={k.id}>
                    <span className={`dot ${k.health}`} aria-hidden="true" />
                    <span className="mem-content">{k.id} — {k.health} · {k.requestCount} req · {k.errorCount} err</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
