import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  cursor_version TEXT,
  extension_version TEXT,
  open_workspaces TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  window_id TEXT,
  workspace_root TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  conversation_id TEXT,
  transcript_path TEXT,
  parent_run_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  machine_id TEXT NOT NULL,
  ext_seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  hook_event_name TEXT,
  payload TEXT NOT NULL,
  ts INTEGER NOT NULL,
  post_terminal INTEGER NOT NULL DEFAULT 0,
  UNIQUE(run_id, seq),
  UNIQUE(machine_id, ext_seq)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  payload TEXT
);
`;

export function openDb(home: string): Database {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, "hub.db"), { create: true });
  db.exec(SCHEMA);
  ensureColumn(db, "machines", "display_name", "display_name TEXT");
  ensureColumn(db, "runs", "archived_at", "archived_at INTEGER");
  ensureColumn(db, "runs", "queued_at", "queued_at INTEGER");
  ensureColumn(db, "runs", "dispatch_seq", "dispatch_seq INTEGER");
  ensureColumn(db, "runs", "attachments", "attachments TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "runs", "live_generation_id", "live_generation_id TEXT");
  ensureColumn(db, "runs", "retired_generation_ids", "retired_generation_ids TEXT NOT NULL DEFAULT '[]'");
  db.exec(`CREATE TABLE IF NOT EXISTS blobs (
    sha256 TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    refcount INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  ensureColumn(db, "blobs", "unref_at", "unref_at INTEGER");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_cid_active ON runs(conversation_id) WHERE conversation_id IS NOT NULL AND status IN ('dispatched','binding','running')`);
  return db;
}

function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
