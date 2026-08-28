import type { Database } from "bun:sqlite";

export interface MachineInfo {
  id: string; name: string; os: string;
  cursorVersion?: string; extensionVersion?: string;
  openWorkspaces: string[];
}

export interface MachineRow {
  id: string; name: string; os: string;
  cursor_version: string | null; extension_version: string | null;
  open_workspaces: string; status: string; last_seen_at: number | null;
}

export class Registry {
  constructor(private db: Database) {}

  upsertMachine(m: MachineInfo): void {
    this.db.query(`
      INSERT INTO machines (id, name, os, cursor_version, extension_version, open_workspaces, status, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'online', ?7)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, os=excluded.os,
        cursor_version=excluded.cursor_version, extension_version=excluded.extension_version,
        open_workspaces=excluded.open_workspaces, status='online', last_seen_at=excluded.last_seen_at
    `).run(m.id, m.name, m.os, m.cursorVersion ?? null, m.extensionVersion ?? null,
           JSON.stringify(m.openWorkspaces), Date.now());
  }

  listMachines(): MachineRow[] {
    return this.db.query("SELECT * FROM machines ORDER BY name").all() as MachineRow[];
  }

  getMachine(id: string): MachineRow | null {
    return (this.db.query("SELECT * FROM machines WHERE id=?1").get(id) as MachineRow) ?? null;
  }

  markOffline(id: string): void {
    this.db.query("UPDATE machines SET status='offline' WHERE id=?1").run(id);
  }
}
