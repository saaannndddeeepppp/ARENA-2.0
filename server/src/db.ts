import Database from "better-sqlite3";
import { resolve } from "node:path";
import { config, initializeStorage } from "./config.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

initializeStorage();
export const db: Database.Database = new Database(
  resolve(config.dataDir, "app.db"),
);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'idle', model_provider TEXT, model_id TEXT, workspace_path TEXT NOT NULL,
 total_tokens INTEGER NOT NULL DEFAULT 0, total_cost_usd REAL NOT NULL DEFAULT 0,
 archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, seq INTEGER NOT NULL,
 tool_calls_json TEXT
);
CREATE INDEX IF NOT EXISTS messages_session_seq ON messages(session_id, seq);
CREATE TABLE IF NOT EXISTS providers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL,
 api_key_enc TEXT NOT NULL DEFAULT '', headers_json TEXT NOT NULL DEFAULT '{}', models_json TEXT NOT NULL DEFAULT '[]',
 models_fetched_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 message_id TEXT, turn INTEGER NOT NULL, tool_name TEXT NOT NULL, args_json TEXT NOT NULL,
 result_json TEXT, status TEXT NOT NULL, error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS costs (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 turn INTEGER NOT NULL, provider TEXT, model TEXT, prompt_tokens INTEGER NOT NULL DEFAULT 0,
 completion_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
 reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 path TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connectors (
 id TEXT PRIMARY KEY, credential_enc TEXT NOT NULL DEFAULT '', config_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_questions (
 call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 question_json TEXT NOT NULL, answer TEXT, created_at INTEGER NOT NULL, answered_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS session_events (
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(session_id,seq)
);
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(session_id UNINDEXED, message_id UNINDEXED, title, content);
CREATE TRIGGER IF NOT EXISTS messages_search_insert AFTER INSERT ON messages BEGIN
 INSERT INTO message_search(session_id,message_id,title,content) SELECT new.session_id,new.id,s.title,new.content FROM sessions s WHERE s.id=new.session_id;
END;
CREATE TRIGGER IF NOT EXISTS sessions_title_search AFTER UPDATE OF title ON sessions BEGIN
 UPDATE message_search SET title=new.title WHERE session_id=new.id;
END;
`);

db.prepare(
  "UPDATE sessions SET status='interrupted' WHERE status='running'",
).run();

for (const migration of [
  "ALTER TABLE sessions ADD COLUMN repo_full_name TEXT",
  "ALTER TABLE sessions ADD COLUMN repo_branch TEXT",
  "ALTER TABLE sessions ADD COLUMN repo_base_branch TEXT",
  "ALTER TABLE sessions ADD COLUMN github_pr_number INTEGER",
  "ALTER TABLE sessions ADD COLUMN repo_locked INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE artifacts ADD COLUMN rel_path TEXT",
  "ALTER TABLE artifacts ADD COLUMN presented INTEGER NOT NULL DEFAULT 0",
]) {
  try {
    db.exec(migration);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("duplicate column")
    )
      throw error;
  }
}

export const now = () => Date.now();
export const id = () => randomUUID();
export type SessionRow = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  status: string;
  model_provider: string | null;
  model_id: string | null;
  workspace_path: string;
  total_tokens: number;
  total_cost_usd: number;
  archived: number;
  pinned: number;
};
export function createSession(title = "New chat") {
  const sessionId = id();
  const timestamp = now();
  const workspace = resolve(config.workspacesDir, sessionId);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  db.prepare(
    "INSERT INTO sessions(id,title,created_at,updated_at,workspace_path) VALUES(?,?,?,?,?)",
  ).run(sessionId, title, timestamp, timestamp, workspace);
  return db
    .prepare("SELECT * FROM sessions WHERE id=?")
    .get(sessionId) as SessionRow;
}
export function addMessage(
  sessionId: string,
  role: string,
  content: string,
  toolCalls?: unknown,
) {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE session_id=?",
    )
    .get(sessionId) as { seq: number };
  const messageId = id();
  const timestamp = now();
  db.prepare(
    "INSERT INTO messages(id,session_id,role,content,created_at,seq,tool_calls_json) VALUES(?,?,?,?,?,?,?)",
  ).run(
    messageId,
    sessionId,
    role,
    content,
    timestamp,
    row.seq,
    toolCalls === undefined ? null : JSON.stringify(toolCalls),
  );
  db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(
    timestamp,
    sessionId,
  );
  return {
    id: messageId,
    session_id: sessionId,
    role,
    content,
    created_at: timestamp,
    seq: row.seq,
  };
}
export function getMessages(sessionId: string) {
  return db
    .prepare("SELECT * FROM messages WHERE session_id=? ORDER BY seq")
    .all(sessionId) as Array<Record<string, unknown>>;
}
