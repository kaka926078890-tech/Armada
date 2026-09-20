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

function migratePushTokenEnvironments(db: Database): void {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='push_tokens'").get() as { sql: string } | null;
  if (!row?.sql || row.sql.includes("'sandbox'")) return;
  db.exec(`
    CREATE TABLE push_tokens_new (
      token TEXT NOT NULL,
      fleet_id TEXT NOT NULL REFERENCES fleets(id),
      environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
      updated_at INTEGER NOT NULL,
      platform TEXT NOT NULL DEFAULT 'apns',
      PRIMARY KEY (fleet_id, token)
    );
    INSERT INTO push_tokens_new (token, fleet_id, environment, updated_at, platform)
      SELECT token, fleet_id, environment, updated_at, COALESCE(platform, 'apns') FROM push_tokens;
    DROP TABLE push_tokens;
    ALTER TABLE push_tokens_new RENAME TO push_tokens;
  `);
}

export function openRelayDb(home: string): Database {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, "relay.db"), { create: true });
  db.exec(SCHEMA);
  ensureColumn(db, "runs", "outbound", "outbound TEXT");
  ensureColumn(db, "runs", "queue_message_default_behavior", "queue_message_default_behavior TEXT");
  ensureColumn(db, "runs", "archived_at", "archived_at INTEGER");
  ensureColumn(db, "runs", "notified_status", "notified_status TEXT");
  ensureColumn(db, "runs", "notified_ask_id", "notified_ask_id TEXT");
  ensureColumn(db, "runs", "title", "title TEXT");
  ensureColumn(db, "runs", "conversation_id", "conversation_id TEXT");
  ensureColumn(db, "runs", "attachments", "attachments TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS push_tokens (
    token TEXT NOT NULL,
    fleet_id TEXT NOT NULL REFERENCES fleets(id),
    environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (fleet_id, token)
  )`);
  ensureColumn(db, "push_tokens", "platform", "platform TEXT NOT NULL DEFAULT 'apns'");
  migratePushTokenEnvironments(db);
  db.exec(`CREATE TABLE IF NOT EXISTS pair_codes (
    code TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL REFERENCES fleets(id),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  )`);
  return db;
}
