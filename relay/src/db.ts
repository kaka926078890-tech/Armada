import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS fleets (
  id TEXT PRIMARY KEY,
  hub_secret TEXT NOT NULL UNIQUE,
  operator_token TEXT NOT NULL UNIQUE,
  hub_online INTEGER NOT NULL DEFAULT 0,
  workspaces TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL REFERENCES fleets(id),
  machine_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  final_text TEXT,
  error TEXT,
  pending_ask TEXT,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
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

function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function openRelayDb(home: string): Database {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, "relay.db"), { create: true });
  db.exec(SCHEMA);
  ensureColumn(db, "runs", "outbound", "outbound TEXT");
  ensureColumn(db, "runs", "queue_message_default_behavior", "queue_message_default_behavior TEXT");
  ensureColumn(db, "runs", "archived_at", "archived_at INTEGER");
  return db;
}
