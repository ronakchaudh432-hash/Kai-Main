// SQLite-backed persistence (zero-config default). Schema mirrors the spec's
// relational design; swapping to PostgreSQL later only requires replacing this
// module's driver calls — all callers use the functions below.
// Uses the Node.js built-in `node:sqlite` module (no native dependencies).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "@/lib/config";

export type Role = "system" | "user" | "assistant" | "tool";

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  timestamp: string;
  metadata: string | null;
}

export interface Memory {
  id: string;
  user_id: string;
  content: string;
  category: string;
  importance: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  source_conversation_id: string | null;
}

let db: DatabaseSync | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

export function uid(prefix = ""): string {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = resolve(/*turbopackIgnore: true*/ process.cwd(), config.sqlitePath);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      summary TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      source_conversation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, importance DESC);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys_metadata (
      key_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'healthy',
      request_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      cooldown_until TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_logs (
      id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      success INTEGER NOT NULL DEFAULT 1,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      tool_usage TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_logs (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '',
      success INTEGER NOT NULL DEFAULT 1,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS answer_cache (
      id TEXT PRIMARY KEY,
      question_normalized TEXT NOT NULL,
      question_hash TEXT NOT NULL,
      answer TEXT NOT NULL,
      sources TEXT,
      model TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL,
      ttl_ms INTEGER NOT NULL DEFAULT 86400000,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cache_hash ON answer_cache(question_hash);
    CREATE TABLE IF NOT EXISTS learning_insights (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      insight_type TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insights_type ON learning_insights(insight_type);
    CREATE TABLE IF NOT EXISTS behavior_patterns (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Ensure the default user + default settings exist
  const hasUser = database
    .prepare("SELECT id FROM users WHERE id = 'default'")
    .get() as { id: string } | undefined;
  if (!hasUser) {
    database
      .prepare("INSERT INTO users (id, created_at) VALUES ('default', ?)")
      .run(nowIso());
  }
  const defaults: Record<string, string> = { memory_enabled: "1" };
  for (const [k, v] of Object.entries(defaults)) {
    const row = database
      .prepare("SELECT key FROM user_settings WHERE key = ?")
      .get(k) as { key: string } | undefined;
    if (!row) {
      database
        .prepare(
          "INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, ?)"
        )
        .run(k, v, nowIso());
    }
  }
}

// ---------- Conversations ----------

export function createConversation(title = "New chat"): Conversation {
  const d = getDb();
  const now = nowIso();
  const conv: Conversation = {
    id: uid("c_"),
    title,
    created_at: now,
    updated_at: now,
  };
  d.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).run(conv.id, conv.title, conv.created_at, conv.updated_at);
  return conv;
}

export function listConversations(limit = 100): Conversation[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as unknown as Conversation[];
}

export function getConversation(id: string): Conversation | null {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(id) as Conversation | undefined;
  return row ?? null;
}

export function renameConversation(id: string, title: string): void {
  const d = getDb();
  d.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(
    title.slice(0, 120) || "New chat",
    nowIso(),
    id
  );
}

export function deleteConversation(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

export function searchConversations(query: string, limit = 30): Conversation[] {
  const d = getDb();
  const q = `%${query}%`;
  return d
    .prepare(
      `SELECT DISTINCT c.* FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.title LIKE ? OR m.content LIKE ? ORDER BY c.updated_at DESC LIMIT ?`
    )
    .all(q, q, limit) as unknown as Conversation[];
}

export function touchConversation(id: string): void {
  getDb()
    .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
    .run(nowIso(), id);
}

// ---------- Messages ----------

export function addMessage(
  conversationId: string,
  role: Role,
  content: string,
  metadata: Record<string, unknown> | null = null
): Message {
  const d = getDb();
  const msg: Message = {
    id: uid("m_"),
    conversation_id: conversationId,
    role,
    content,
    timestamp: nowIso(),
    metadata: metadata ? JSON.stringify(metadata) : null,
  };
  d.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(msg.id, msg.conversation_id, msg.role, msg.content, msg.timestamp, msg.metadata);
  touchConversation(conversationId);
  return msg;
}

export function getMessages(conversationId: string, limit = 200): Message[] {
  const d = getDb();
  return d
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT ?"
    )
    .all(conversationId, limit) as unknown as Message[];
}

export function getRecentMessages(conversationId: string, limit = 40): Message[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?"
    )
    .all(conversationId, limit) as unknown as Message[];
  return rows.reverse();
}

// ---------- Summaries ----------

export function getSummary(conversationId: string): string {
  const d = getDb();
  const row = d
    .prepare("SELECT summary FROM conversation_summaries WHERE conversation_id = ?")
    .get(conversationId) as { summary: string } | undefined;
  return row?.summary ?? "";
}

export function setSummary(conversationId: string, summary: string): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO conversation_summaries (conversation_id, summary, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`
  ).run(conversationId, summary, nowIso());
}

// ---------- Settings ----------

export function getSetting(key: string, fallback = ""): string {
  const d = getDb();
  const row = d
    .prepare("SELECT value FROM user_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, nowIso());
}

// ---------- Observability ----------

export function logUsage(entry: {
  keyId: string;
  model: string;
  success: boolean;
  latencyMs: number;
  retryCount: number;
  toolUsage: string;
}): void {
  try {
    getDb()
      .prepare(
        "INSERT INTO usage_logs (id, key_id, model, success, latency_ms, retry_count, tool_usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        uid("u_"),
        entry.keyId,
        entry.model,
        entry.success ? 1 : 0,
        entry.latencyMs,
        entry.retryCount,
        entry.toolUsage,
        nowIso()
      );
  } catch {
    // Observability must never break a chat request
  }
}

export function logTool(toolName: string, input: string, success: boolean, latencyMs: number): void {
  try {
    getDb()
      .prepare(
        "INSERT INTO tool_logs (id, tool_name, input, success, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(uid("t_"), toolName, input.slice(0, 2000), success ? 1 : 0, latencyMs, nowIso());
  } catch {
    // ignore
  }
}
