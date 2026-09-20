export interface RunRow {
  id: string; machine_id: string; window_id: string | null; workspace_root: string;
  prompt: string; title?: string | null; status: string; conversation_id: string | null;
  transcript_path: string | null; parent_run_id: string | null;
  created_at: number; started_at: number | null; ended_at: number | null; end_reason: string | null;
  archived_at?: number | null;
  attachments?: string | null;
  pending_ask?: {
    request_id: string;
    kind?: "plan";
    questions: { id: string; prompt: string; allow_multiple?: boolean; options: { id: string; label: string; text: string; freeform?: boolean }[] }[];
    detected_at?: number;
    detect_via?: string;
  } | null;
  outbound?: {
    id: string; prompt: string; expected_mode: string; state: string; created_at: number;
  }[];
  queue_message_default_behavior?: string | null;
}

/** 卡片展示名：操作员改过的 title 优先，否则最近一次注入的 prompt。 */
export function runDisplayName(run: Pick<RunRow, "title" | "prompt">): string {
  return (run.title ?? "").trim() || run.prompt.trim();
}

/** 五列卡片标题截取：约两行 CJK（列宽 ≥240px）。完整文案留给 hover / 详情。 */
export const CARD_TITLE_MAX_CHARS = 40;

export function clipCardTitle(text: string, max = CARD_TITLE_MAX_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** Board EventSource: skip jsonl `run.event` floods; merge status edges. */
export const BOARD_SSE_DEBOUNCE_MS = 250;

const BOARD_SSE_REFRESH_TYPES = new Set([
  "machine.updated",
  "run.status",
  "run.archived",
  "run.ask",
  "run.outbound",
]);

export function boardSseShouldRefresh(raw: string): boolean {
  try {
    const t = (JSON.parse(raw) as { type?: unknown }).type;
    return typeof t === "string" && BOARD_SSE_REFRESH_TYPES.has(t);
  } catch {
    return false;
  }
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
    const ids = (() => {
      try {
        const p = JSON.parse(run.attachments || "[]");
        return Array.isArray(p) ? p : [];
      } catch { return []; }
    })();
  const named = runDisplayName(run);
  const title = named || (ids.length ? `[${ids.length} 个附件]` : named);

  const from = run.started_at ?? run.created_at;
  const secs = Math.max(0, Math.floor(((run.ended_at ?? now) - from) / 1000));
  const elapsed = secs > 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
  const badge = run.status === "queued" ? "排队中"
    : run.status === "binding" ? "绑定中"
    : run.status === "running" && run.pending_ask ? "待处理"
    : COLUMN_LABELS[COLUMN_MAP[run.status] ?? "error"];
  return { title, elapsed, badge };
}

export type WorkspaceSlot = {
  machineId: string;
  machineName: string;
  os: string;
  root: string;
  online: boolean;
  cdpReady: boolean;
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

/** 中台当前打包的 vsix。落后的被控机看不到 Ask 归属 / Created Plan。 */
export const REQUIRED_EXTENSION_VERSION = "0.4.31";

export const CDP_NOT_READY_COPY =
  "Cursor 在线但无法注入。请确认已安装最新 Armada 扩展，并用 Armada 打开工作区。若窗口已开、调试口不通：请完全退出 Cursor（Mac Cmd+Q / Windows 托盘 Exit），不要点 Cursor 图标。";

function parseExtVersion(raw: string | null | undefined): [number, number, number] | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function extensionLagNotice(
  installed: string | null | undefined,
  required = REQUIRED_EXTENSION_VERSION,
): string | null {
  const got = parseExtVersion(installed);
  const need = parseExtVersion(required);
  if (!got || !need) return null;
  for (let i = 0; i < 3; i++) {
    if (got[i] > need[i]) return null;
    if (got[i] < need[i]) return `扩展 ${got.join(".")}，需 ${need.join(".")}（Ask / Build）`;
  }
  return null;
}

export function listWorkspaceSlots(machines: Array<{
  id: string; name: string; os: string; status: string; open_workspaces: string; display_name?: string | null;
  cdp_ready?: boolean | null;
}>): WorkspaceSlot[] {
  const out: WorkspaceSlot[] = [];
  for (const m of machines) {
    let roots: string[] = [];
    try {
      const parsed = JSON.parse(m.open_workspaces || "[]");
      if (Array.isArray(parsed)) roots = parsed.filter((x): x is string => typeof x === "string");
    } catch { continue; }
    for (const root of roots) {
      out.push({
        machineId: m.id, machineName: machineLabel(m), os: m.os, root,
        online: m.status === "online",
        cdpReady: m.cdp_ready === true,
      });
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

export function resolveSelectedWorkspace(
  slots: WorkspaceSlot[],
  selectedWs: string | null,
  selectedRun: { machine_id: string; workspace_root: string } | null,
): string | null {
  if (selectedWs && slots.some((s) => encodeWorkspaceKey(s.machineId, s.root) === selectedWs)) {
    return selectedWs;
  }
  if (
    selectedWs &&
    selectedRun &&
    encodeWorkspaceKey(selectedRun.machine_id, selectedRun.workspace_root) === selectedWs
  ) {
    return selectedWs;
  }
  const first = slots.find((s) => s.online) ?? slots[0];
  return first ? encodeWorkspaceKey(first.machineId, first.root) : null;
}

export function filterRunsByWorkspace(runs: RunRow[], machineId: string, root: string): RunRow[] {
  return runs.filter((r) => r.machine_id === machineId && r.workspace_root === root);
}

const LIVE = new Set(["created", "queued", "dispatched", "binding", "running"]);

/** 工作区展示名：路径最后一段。Windows `\` 与 POSIX `/` 都认。 */
export function workspaceFolderName(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (!trimmed) return root;
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (sep >= 0 ? trimmed.slice(sep + 1) : trimmed) || root;
}

export function workspaceHasLiveRun(runs: RunRow[]): boolean {
  return runs.some((r) => LIVE.has(r.status));
}

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

export function isUnreadNeedInput(run: RunRow, readAt: number | undefined): boolean {
  if (!run.pending_ask) return false;
  const at = run.pending_ask.detected_at ?? 0;
  return readAt == null || at > readAt;
}

export function isUnreadAlert(run: RunRow, readAt: number | undefined): boolean {
  if (!["completed", "error", "unknown", "aborted"].includes(run.status)) return false;
  return readAt == null || runActivityTs(run) > readAt;
}

export function isUnreadCompleted(run: RunRow, readAt: number | undefined): boolean {
  return run.status === "completed" && isUnreadAlert(run, readAt);
}

export type CardChrome = "need" | "done" | "fail" | "none";

/** 待操作红条一直在；完成绿条 / 异常红条只给未读。 */
export function cardChromeOf(
  run: Pick<RunRow, "status" | "pending_ask" | "ended_at" | "started_at" | "created_at">,
  readAt?: number,
): CardChrome {
  if (run.pending_ask) return "need";
  if (run.status === "completed" && (readAt == null || runActivityTs(run as RunRow) > readAt)) return "done";
  if (["error", "unknown", "aborted"].includes(run.status) && (readAt == null || runActivityTs(run as RunRow) > readAt)) {
    return "fail";
  }
  return "none";
}

export function cardChromeClass(chrome: CardChrome, selected: boolean): string {
    const selectedRing = selected ? " ring-1 ring-primary/40" : "";
  if (chrome === "need" || chrome === "fail") {
    return `border-border border-l-[3px] border-l-red-400 bg-card${selectedRing}`;
  }
  if (chrome === "done") {
    return `border-border border-l-[3px] border-l-emerald-400 bg-card${selectedRing}`;
  }
  if (selected) return "border-primary/80 bg-card";
  return "border-transparent bg-card/50 hover:border-border";
}

/** 列上的红点：该列有待答 Ask 或未读失败/中止。已完成未读走绿条，不算问题点。 */
export function columnHasAlert(runs: RunRow[], column: ColumnKey, readMap: Record<string, number>): boolean {
  return runs.some((r) => {
    if ((COLUMN_MAP[r.status] ?? "error") !== column) return false;
    const chrome = cardChromeOf(r, readMap[r.id]);
    return chrome === "need" || chrome === "fail";
  });
}

/** 侧栏未读数：终态未读（完成/失败/异常/中止）。进行中不计入。 */
export function workspaceUnreadCount(runs: RunRow[], readMap: Record<string, number>): number {
  let n = 0;
  for (const r of runs) {
    if (isUnreadAlert(r, readMap[r.id]) || isUnreadNeedInput(r, readMap[r.id])) n++;
  }
  return n;
}

export function formatUnreadCount(n: number): string {
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

export function workspaceHasUnread(runs: RunRow[], readMap: Record<string, number>): boolean {
  return workspaceUnreadCount(runs, readMap) > 0;
}

export function isHubArchived(run: Pick<RunRow, "archived_at">): boolean {
  return run.archived_at != null && run.archived_at > 0;
}

export function canArchiveRun(run: Pick<RunRow, "status">): boolean {
  return !LIVE.has(run.status);
}

const RETRY_STATUSES = ["error", "unknown", "aborted"] as const;

/** 失败 / 未知 / 中止：同一张卡再派发或续上原对话。已取消、已完成不重试。 */
export function canRetryRun(run: Pick<RunRow, "status">): boolean {
  return (RETRY_STATUSES as readonly string[]).includes(run.status);
}
