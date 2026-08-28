import type { Database } from "bun:sqlite";
import type { ArmadaSocket } from "./ws";

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

type Conn = { ws: ArmadaSocket; machineId: string; windowId: string };

export class Registry {
  private conns = new Map<string, Conn>();
  public onMachineOffline: (machineId: string) => void = () => {};

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

  // ---- WS 连接管理 ----

  onOpen(ws: ArmadaSocket): void {
    ws.data.regTimer = setTimeout(() => {
      if (!ws.data.registered) ws.close(4001, "unauthorized");
    }, 10_000);
  }

  onRegister(ws: ArmadaSocket, msg: any): void {
    if (ws.data.regTimer) { clearTimeout(ws.data.regTimer); ws.data.regTimer = undefined; }
    const connKey = `${msg.machineId}:${msg.windowId}`;
    const old = this.conns.get(connKey);
    if (old && old.ws !== ws) old.ws.close(4000, "replaced");
    ws.data.registered = true;
    ws.data.connKey = connKey;
    ws.data.machineId = msg.machineId;
    ws.data.windowId = msg.windowId;
    this.conns.set(connKey, { ws, machineId: msg.machineId, windowId: msg.windowId });
    this.upsertMachine({
      id: msg.machineId, name: msg.name, os: msg.os,
      cursorVersion: msg.cursorVersion, extensionVersion: msg.extensionVersion,
      openWorkspaces: msg.openWorkspaces ?? [],
    });
    ws.send(JSON.stringify({ type: "registered", machineId: msg.machineId }));
  }

  onHeartbeat(ws: ArmadaSocket, msg: any): void {
    const id = ws.data.machineId;
    if (!id) return;
    this.db.query(
      "UPDATE machines SET open_workspaces=?1, last_seen_at=?2, status='online' WHERE id=?3"
    ).run(JSON.stringify(msg.openWorkspaces ?? []), Date.now(), id);
  }

  onClose(ws: ArmadaSocket): void {
    if (ws.data.regTimer) { clearTimeout(ws.data.regTimer); ws.data.regTimer = undefined; }
    const key = ws.data.connKey;
    if (key && this.conns.get(key)?.ws === ws) this.conns.delete(key);
  }

  sweep(now = Date.now()): void {
    const stale = this.db.query(
      "SELECT id FROM machines WHERE status='online' AND last_seen_at < ?1"
    ).all(now - 45_000) as { id: string }[];
    for (const { id } of stale) {
      this.markOffline(id);
      this.onMachineOffline(id);
    }
  }

  sendTo(machineId: string, windowId: string, msg: object): boolean {
    const c = this.conns.get(`${machineId}:${windowId}`);
    if (!c) return false;
    c.ws.send(JSON.stringify(msg));
    return true;
  }

  findWindowForWorkspace(machineId: string, workspaceRoot: string): { machineId: string; windowId: string } | null {
    for (const c of this.conns.values()) {
      if (c.machineId !== machineId) continue;
      const m = this.getMachine(machineId);
      if (m && JSON.parse(m.open_workspaces).includes(workspaceRoot)) {
        return { machineId: c.machineId, windowId: c.windowId };
      }
    }
    return null;
  }

  dispatchInbound(_ws: ArmadaSocket, _msg: any): void { /* Task 4/5 填充 */ }
}
