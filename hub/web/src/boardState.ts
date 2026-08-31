export interface RunRow {
  id: string; machine_id: string; window_id: string | null; workspace_root: string;
  prompt: string; status: string; conversation_id: string | null;
  transcript_path: string | null; parent_run_id: string | null;
  created_at: number; started_at: number | null; ended_at: number | null; end_reason: string | null;
  archived_at?: number | null;
}

export type ColumnKey = "waiting" | "running" | "completed" | "cancelled" | "error";

const COLUMN_MAP: Record<string, ColumnKey> = {
  created: "waiting", queued: "waiting", dispatched: "waiting", binding: "waiting",
  running: "running", completed: "completed",
  cancelled: "cancelled", aborted: "cancelled",
  error: "error", unknown: "error",
};

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  waiting: "待本机回车", running: "运行中", completed: "已完成", cancelled: "已取消", error: "异常",
};

export function groupRuns(runs: RunRow[]): Record<ColumnKey, RunRow[]> {
  const g: Record<ColumnKey, RunRow[]> = { waiting: [], running: [], completed: [], cancelled: [], error: [] };
  for (const r of runs) g[COLUMN_MAP[r.status] ?? "error"].push(r);
  return g;
}

export function cardView(run: RunRow, now: number): { title: string; elapsed: string; badge: string } {
  const title = run.prompt.length > 40 ? run.prompt.slice(0, 40) + "…" : run.prompt;
  const from = run.started_at ?? run.created_at;
  const secs = Math.max(0, Math.floor(((run.ended_at ?? now) - from) / 1000));
  const elapsed = secs > 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
  const badge = run.status === "queued" ? "排队中"
    : run.status === "binding" ? "绑定中"
    : COLUMN_LABELS[COLUMN_MAP[run.status] ?? "error"];
  return { title, elapsed, badge };
}

export type WorkspaceSlot = {
  machineId: string;
  machineName: string;
  os: string;
  root: string;
  online: boolean;
};

export function encodeWorkspaceKey(machineId: string, root: string): string {
  return JSON.stringify([machineId, root]);
}

export function decodeWorkspaceKey(raw: string | null): { machineId: string; root: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { machineId: parsed[0], root: parsed[1] };
    }
  } catch { /* ignore */ }
  return null;
}

export function machineLabel(m: { name: string; display_name?: string | null }): string {
  const d = m.display_name?.trim();
  return d || m.name;
}

export function listWorkspaceSlots(machines: Array<{
  id: string; name: string; os: string; status: string; open_workspaces: string; display_name?: string | null;
}>): WorkspaceSlot[] {
  const out: WorkspaceSlot[] = [];
  for (const m of machines) {
    let roots: string[] = [];
    try {
      const parsed = JSON.parse(m.open_workspaces || "[]");
      if (Array.isArray(parsed)) roots = parsed.filter((x): x is string => typeof x === "string");
    } catch { continue; }
    for (const root of roots) {
      out.push({ machineId: m.id, machineName: machineLabel(m), os: m.os, root, online: m.status === "online" });
    }
  }
  return out;
}

export type MachineGroup = {
  machineId: string;
  machineName: string;
  os: string;
  online: boolean;
  workspaces: WorkspaceSlot[];
};

export function groupSlotsByMachine(slots: WorkspaceSlot[]): MachineGroup[] {
  const order: string[] = [];
  const map = new Map<string, MachineGroup>();
  for (const s of slots) {
    let g = map.get(s.machineId);
    if (!g) {
      g = { machineId: s.machineId, machineName: s.machineName, os: s.os, online: s.online, workspaces: [] };
      map.set(s.machineId, g);
      order.push(s.machineId);
    }
    g.workspaces.push(s);
    if (s.online) g.online = true;
  }
  return order.map((id) => map.get(id)!);
}

export function filterRunsByWorkspace(runs: RunRow[], machineId: string, root: string): RunRow[] {
  return runs.filter((r) => r.machine_id === machineId && r.workspace_root === root);
}

const LIVE = new Set(["created", "queued", "dispatched", "binding", "running"]);

export function sortConversations(runs: RunRow[]): RunRow[] {
  return runs.toSorted((a, b) => {
    const live = Number(LIVE.has(b.status)) - Number(LIVE.has(a.status));
    if (live !== 0) return live;
    return b.created_at - a.created_at;
  });
}

export function runActivityTs(run: RunRow): number {
  return run.ended_at ?? run.started_at ?? run.created_at;
}

/** 有未读消息（进行中/完成/异常，且上次打开早于最近活动） */
export function isUnreadMessage(run: RunRow, readAt: number | undefined): boolean {
  if (["cancelled", "aborted"].includes(run.status)) return false;
  return readAt == null || runActivityTs(run) > readAt;
}

export function isUnreadCompleted(run: RunRow, readAt: number | undefined): boolean {
  return run.status === "completed" && isUnreadMessage(run, readAt);
}

/** 侧栏红点：仅未读的已完成任务。进行中不亮，避免任务还没结束就提前提示。 */
export function workspaceHasUnread(runs: RunRow[], readMap: Record<string, number>): boolean {
  return runs.some((r) => isUnreadCompleted(r, readMap[r.id]));
}

export function isHubArchived(run: Pick<RunRow, "archived_at">): boolean {
  return run.archived_at != null && run.archived_at > 0;
}

export function canArchiveRun(run: Pick<RunRow, "status">): boolean {
  return !LIVE.has(run.status);
}
