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
  display_name: string | null;
}

type Conn = { ws: ArmadaSocket; machineId: string; windowId: string; openWorkspaces: string[]; extensionVersion: string | null };

export function workspaceListChanged(prev: string[], next: string[]): boolean {
  if (prev.length !== next.length) return true;
  const a = [...prev].sort();
  const b = [...next].sort();
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}

export class Registry {
  private conns = new Map<string, Conn>();
  public onMachineOffline: (machineId: string) => void = () => {};
  public onMachinesChanged: () => void = () => {};

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

  setDisplayName(id: string, displayName: string | null): { error?: string; machine?: MachineRow } {
    if (!this.getMachine(id)) return { error: "NOT_FOUND" };
    const next = displayName == null ? null : displayName.trim().slice(0, 40);
    const stored = next === "" ? null : next;
    this.db.query("UPDATE machines SET display_name=?1 WHERE id=?2").run(stored, id);
    return { machine: this.getMachine(id)! };
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
    this.conns.set(connKey, {
      ws, machineId: msg.machineId, windowId: msg.windowId,
      openWorkspaces: msg.openWorkspaces ?? [],
      extensionVersion: typeof msg.extensionVersion === "string" ? msg.extensionVersion : null,
    });
    this.upsertMachine({
      id: msg.machineId, name: msg.name, os: msg.os,
      cursorVersion: msg.cursorVersion, extensionVersion: msg.extensionVersion,
      openWorkspaces: msg.openWorkspaces ?? [],
    });
    this.refreshMachineWorkspaces(msg.machineId);
    this.onMachinesChanged();
    ws.send(JSON.stringify({ type: "registered", machineId: msg.machineId }));
  }

  onHeartbeat(ws: ArmadaSocket, msg: any): void {
    const id = ws.data.machineId;
    if (!id) return;
    const conn = ws.data.connKey ? this.conns.get(ws.data.connKey) : undefined;
    if (conn && conn.ws === ws) conn.openWorkspaces = msg.openWorkspaces ?? [];
    if (this.refreshMachineWorkspaces(id)) this.onMachinesChanged();
    this.db.query(
      "UPDATE machines SET last_seen_at=?1, status='online' WHERE id=?2"
    ).run(Date.now(), id);
  }

  /** 机器级 open_workspaces = 该机器所有在线连接工作区的并集(仅用于展示;路由按连接级匹配)。 */
  private storedWorkspaces(machineId: string): string[] {
    const row = this.getMachine(machineId);
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.open_workspaces || "[]");
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /** @returns whether the stored union changed */
  private refreshMachineWorkspaces(machineId: string): boolean {
    const union = new Set<string>();
    for (const c of this.conns.values()) {
      if (c.machineId !== machineId) continue;
      for (const w of c.openWorkspaces) union.add(w);
    }
    if (union.size === 0) return false; // 无在线连接时保留最后已知值
    const next = [...union];
    const prev = this.storedWorkspaces(machineId);
    if (!workspaceListChanged(prev, next)) return false;
    this.db.query("UPDATE machines SET open_workspaces=?1 WHERE id=?2")
      .run(JSON.stringify(next), machineId);
    return true;
  }

  onClose(ws: ArmadaSocket): void {
    if (ws.data.regTimer) { clearTimeout(ws.data.regTimer); ws.data.regTimer = undefined; }
    const key = ws.data.connKey;
    if (key && this.conns.get(key)?.ws === ws) {
      this.conns.delete(key);
      if (ws.data.machineId && this.refreshMachineWorkspaces(ws.data.machineId)) {
        this.onMachinesChanged();
      }
    }
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
      if (c.openWorkspaces.includes(workspaceRoot)) {
        return { machineId: c.machineId, windowId: c.windowId };
      }
    }
    return null;
  }

  windowExtensionVersion(machineId: string, windowId: string): string | null {
    return this.conns.get(`${machineId}:${windowId}`)?.extensionVersion ?? null;
  }

  public inboundHandler: (ws: ArmadaSocket, msg: any) => void = () => {};

  dispatchInbound(ws: ArmadaSocket, msg: any): void {
    this.inboundHandler(ws, msg);
  }
}
