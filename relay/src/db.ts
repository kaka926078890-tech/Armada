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

export function openRelayDb(home: string): Database {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, "relay.db"), { create: true });
  db.exec(SCHEMA);
  return db;
}
