import type { Database } from "bun:sqlite";
import type { ArmadaSocket } from "./ws";
import { cmpSemver } from "../../desktop-core/src/cursorReload";
import { workspacePathIn, workspacePathsEqual } from "../../extension/src/workspacePath";

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
  queue_message_default_behavior?: string | null;
  cdp_ready?: boolean | null;
}

type Conn = {
  ws: ArmadaSocket; machineId: string; windowId: string; openWorkspaces: string[];
  extensionVersion: string | null; cdpReady: boolean | null;
};

export function parseCdpReady(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export type InjectRoute =
  | { ok: true; windowId: string }
  | { ok: false; error: "WORKSPACE_NOT_OPEN" | "CDP_NOT_READY" };

export function workspaceListChanged(prev: string[], next: string[]): boolean {
  if (prev.length !== next.length) return true;
  const a = [...prev].sort();
  const b = [...next].sort();
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}

/** First vsix that actually opens a second OS window (`duplicateWorkspaceInNewWindow`). */
export const OPEN_WINDOW_MIN_EXT = "0.4.40";

export type OpenWindowCandidate = {
  windowId: string;
  openWorkspaces: string[];
  extensionVersion: string | null;
};

/** Prefer a 0.4.40+ peer so a busy unrestored window is not asked to openFolder its own folder. */
export function pickOpenWindowExecutor(
  windows: OpenWindowCandidate[],
  workspaceRoot: string,
): string | null {
  const capable = windows.filter((w) =>
    typeof w.extensionVersion === "string" && cmpSemver(w.extensionVersion, OPEN_WINDOW_MIN_EXT) >= 0,
  );
  const pool = capable.length > 0 ? capable : windows;
  const same = pool.find((w) => workspacePathIn(workspaceRoot, w.openWorkspaces));
  return same?.windowId ?? pool[0]?.windowId ?? null;
}

export class Registry {
  private conns = new Map<string, Conn>();
  /** Workspaces this process has seen on a live socket. Cleared when the machine has no connections. */
  private everOpen = new Map<string, Set<string>>();
  public onMachineOffline: (machineId: string) => void = () => {};
  public onMachinesChanged: () => void = () => {};
  public onRegistered: (machineId: string, windowId: string) => void = () => {};

  constructor(private db: Database) {
    // Previous hub left machines `online`. This process has no sockets yet —
    // display offline without onMachineOffline (that would MACHINE_OFFLINE live runs).
    this.db.query(
      "UPDATE machines SET status='offline', open_workspaces='[]' WHERE status='online'",
    ).run();
    this.db.query(
      "UPDATE machines SET open_workspaces='[]' WHERE status='offline' AND open_workspaces != '[]'",
    ).run();
  }

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
    const rows = this.db.query("SELECT * FROM machines ORDER BY name").all() as MachineRow[];
    return rows.map((r) => ({ ...r, cdp_ready: this.machineCdpReady(r.id) }));
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
    const row = this.getMachine(id);
    if (!row) return;
    const already = row.status === "offline" && row.open_workspaces === "[]";
    this.db.query("UPDATE machines SET status='offline', open_workspaces='[]' WHERE id=?1").run(id);
    if (!already) this.onMachinesChanged();
  }

  // ---- WS 连接管理 ----

  onOpen(ws: ArmadaSocket): void {
    ws.data.regTimer = setTimeout(() => {
      if (!ws.data.registered) ws.close(4001, "unauthorized");
    }, 10_000);
  }

  onRegister(ws: ArmadaSocket, msg: any): void {
    if (ws.data.regTimer) { clearTimeout(ws.data.regTimer); ws.data.regTimer = undefined; }
    const machineId = typeof msg.machineId === "string" ? msg.machineId.trim() : "";
    const windowId = typeof msg.windowId === "string" ? msg.windowId.trim() : "";
    const os = typeof msg.os === "string" ? msg.os.trim() : "";
    if (!machineId || !windowId || !os) {
      ws.close(4001, "unauthorized");
      return;
    }
    const connKey = `${machineId}:${windowId}`;
    const old = this.conns.get(connKey);
    if (old && old.ws !== ws) old.ws.close(4000, "replaced");
    ws.data.registered = true;
    ws.data.connKey = connKey;
    ws.data.machineId = machineId;
    ws.data.windowId = windowId;
    this.conns.set(connKey, {
      ws, machineId, windowId,
      openWorkspaces: msg.openWorkspaces ?? [],
      extensionVersion: typeof msg.extensionVersion === "string" ? msg.extensionVersion : null,
      cdpReady: parseCdpReady(msg.cdpReady),
    });
    this.upsertMachine({
      id: machineId, name: msg.name, os,
      cursorVersion: msg.cursorVersion, extensionVersion: msg.extensionVersion,
      openWorkspaces: msg.openWorkspaces ?? [],
    });
    this.refreshMachineWorkspaces(machineId);
    this.onMachinesChanged();
    ws.send(JSON.stringify({ type: "registered", machineId }));
    this.onRegistered(machineId, windowId);
  }

  onHeartbeat(ws: ArmadaSocket, msg: any): void {
    const id = ws.data.machineId;
    if (!id) return;
    const conn = ws.data.connKey ? this.conns.get(ws.data.connKey) : undefined;
    const prevReady = id ? this.machineCdpReady(id) : null;
    if (conn && conn.ws === ws) {
      conn.openWorkspaces = msg.openWorkspaces ?? [];
      if (typeof msg.cdpReady === "boolean") conn.cdpReady = msg.cdpReady;
    }
    const wsChanged = this.refreshMachineWorkspaces(id);
    const readyChanged = this.machineCdpReady(id) !== prevReady;
    if (wsChanged || readyChanged) this.onMachinesChanged();
    this.db.query(
      "UPDATE machines SET last_seen_at=?1, status='online' WHERE id=?2"
    ).run(Date.now(), id);
    if (typeof msg.queueMessageDefaultBehavior === "string") {
      this.db.query("UPDATE machines SET queue_message_default_behavior=?1 WHERE id=?2")
        .run(msg.queueMessageDefaultBehavior, id);
    }
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
    const next = [...union];
    let seen = this.everOpen.get(machineId);
    if (!seen) {
      seen = new Set();
      this.everOpen.set(machineId, seen);
    }
    for (const w of next) seen.add(w);
    const prev = this.storedWorkspaces(machineId);
    if (!workspaceListChanged(prev, next)) return false;
    this.db.query("UPDATE machines SET open_workspaces=?1 WHERE id=?2")
      .run(JSON.stringify(next), machineId);
    return true;
  }

  /** True only if this process already saw the root on a live socket and it is gone from the union. */
  workspaceDropped(machineId: string, workspaceRoot: string): boolean {
    const seen = this.everOpen.get(machineId);
    if (!seen) return false;
    const known = [...seen].some((r) => workspacePathsEqual(r, workspaceRoot));
    if (!known) return false;
    return !workspacePathIn(workspaceRoot, this.storedWorkspaces(machineId));
  }

  onClose(ws: ArmadaSocket): void {
    if (ws.data.regTimer) { clearTimeout(ws.data.regTimer); ws.data.regTimer = undefined; }
    const key = ws.data.connKey;
    if (key && this.conns.get(key)?.ws === ws) {
      const mid = ws.data.machineId;
      const prevReady = mid ? this.machineCdpReady(mid) : null;
      this.conns.delete(key);
      if (mid) {
        const still = [...this.conns.values()].some((c) => c.machineId === mid);
        if (!still) this.everOpen.delete(mid);
        const wsChanged = this.refreshMachineWorkspaces(mid);
        const readyChanged = this.machineCdpReady(mid) !== prevReady;
        if (wsChanged || readyChanged) this.onMachinesChanged();
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

  isConnected(machineId: string, windowId: string): boolean {
    return this.conns.has(`${machineId}:${windowId}`);
  }

  sendTo(machineId: string, windowId: string, msg: object): boolean {
    const c = this.conns.get(`${machineId}:${windowId}`);
    if (!c) return false;
    c.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Push to every live extension socket, or only one machine. */
  sendToConnected(msg: object, machineId?: string): number {
    let n = 0;
    for (const c of this.conns.values()) {
      if (machineId && c.machineId !== machineId) continue;
      c.ws.send(JSON.stringify(msg));
      n += 1;
    }
    return n;
  }

  findWindowForWorkspace(machineId: string, workspaceRoot: string): { machineId: string; windowId: string } | null {
    const ids = this.windowsForWorkspace(machineId, workspaceRoot);
    return ids.length ? { machineId, windowId: ids[0]! } : null;
  }

  findWindowToOpenWorkspace(machineId: string, workspaceRoot: string): { machineId: string; windowId: string } | null {
    const windows: OpenWindowCandidate[] = [];
    for (const c of this.conns.values()) {
      if (c.machineId !== machineId) continue;
      windows.push({
        windowId: c.windowId,
        openWorkspaces: c.openWorkspaces,
        extensionVersion: c.extensionVersion,
      });
    }
    const windowId = pickOpenWindowExecutor(windows, workspaceRoot);
    return windowId ? { machineId, windowId } : null;
  }

  windowsForWorkspace(machineId: string, workspaceRoot: string): string[] {
    const ids: string[] = [];
    for (const c of this.conns.values()) {
      if (c.machineId !== machineId) continue;
      if (c.openWorkspaces.includes(workspaceRoot)) ids.push(c.windowId);
    }
    return ids;
  }

  windowCdpReady(machineId: string, windowId: string): boolean | null {
    return this.conns.get(`${machineId}:${windowId}`)?.cdpReady ?? null;
  }

  machineCdpReady(machineId: string): boolean | null {
    const mine = [...this.conns.values()].filter((c) => c.machineId === machineId);
    if (mine.length === 0) return null;
    if (mine.some((c) => c.cdpReady === true)) return true;
    return false;
  }

  routeForInject(machineId: string, workspaceRoot: string): InjectRoute {
    const win = this.findWindowForWorkspace(machineId, workspaceRoot);
    if (!win) return { ok: false, error: "WORKSPACE_NOT_OPEN" };
    if (this.windowCdpReady(machineId, win.windowId) !== true) {
      return { ok: false, error: "CDP_NOT_READY" };
    }
    return { ok: true, windowId: win.windowId };
  }

  windowExtensionVersion(machineId: string, windowId: string): string | null {
    return this.conns.get(`${machineId}:${windowId}`)?.extensionVersion ?? null;
  }

  public inboundHandler: (ws: ArmadaSocket, msg: any) => void = () => {};

  dispatchInbound(ws: ArmadaSocket, msg: any): void {
    this.inboundHandler(ws, msg);
  }
}
