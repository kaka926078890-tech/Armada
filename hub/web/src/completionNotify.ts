import type { RunRow } from "./boardState";
import { requestDesktopAlert } from "./desktopBridge";

export const BASE_TITLE = "Armada";
const ASKED_KEY = "armada.notifyAsked.v1";

export const ALERT_STATUSES = ["completed", "error", "unknown", "aborted"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_TITLE: Record<AlertStatus, string> = {
  completed: "Armada 任务完成",
  error: "Armada 任务失败",
  unknown: "Armada 任务异常",
  aborted: "Armada 任务已中止",
};

export function isAlertStatus(s: string): s is AlertStatus {
  return (ALERT_STATUSES as readonly string[]).includes(s);
}

/** 把 prev 推进到当前 runs，返回本次新进入 ALERT_STATUSES 的卡片。首次调用前应先 seed。 */
export function takeNewlyAlertable(prev: Map<string, string>, runs: RunRow[]): RunRow[] {
  const out: RunRow[] = [];
  for (const r of runs) {
    const last = prev.get(r.id);
    // After seed: new id already terminal (fast local test) still fires — same as unread red.
    // Seed snapshot itself uses seedRunStatus and must not toast history.
    if (isAlertStatus(r.status) && (last == null || !isAlertStatus(last))) out.push(r);
    prev.set(r.id, r.status);
  }
  return out;
}

export function seedRunStatus(runs: RunRow[]): Map<string, string> {
  return new Map(runs.map((r) => [r.id, r.status]));
}

export const NEED_INPUT_TITLE = "Armada 需要你处理";

export function pendingAskId(run: RunRow): string | null {
  const id = run.pending_ask?.request_id;
  return typeof id === "string" && id.trim() ? id : null;
}

export function seedAskStatus(runs: RunRow[]): Map<string, string | null> {
  return new Map(runs.map((r) => [r.id, pendingAskId(r)]));
}

/** 新出现或换了 request_id 的 pending_ask。变 null 只更新快照，不弹完成。 */
export function takeNewlyNeedInput(prev: Map<string, string | null>, runs: RunRow[]): RunRow[] {
  const out: RunRow[] = [];
  for (const r of runs) {
    const next = pendingAskId(r);
    const last = prev.get(r.id);
    if (next && next !== last) out.push(r);
    prev.set(r.id, next);
  }
  return out;
}

export function needInputBody(run: RunRow): string {
  const prompt = run.pending_ask?.questions?.[0]?.prompt;
  if (typeof prompt === "string" && prompt.trim()) return prompt.replace(/\s+/g, " ").trim().slice(0, 120);
  return completionBody(run);
}

export function completionHeadline(runs: RunRow[]): string {
  if (runs.length === 0) return BASE_TITLE;
  if (runs.length === 1) {
    const t = (runs[0].title || runs[0].prompt).replace(/\s+/g, " ").trim().slice(0, 40);
    return `【完成】${t} — ${BASE_TITLE}     `;
  }
  return `【${runs.length} 个任务完成】${BASE_TITLE}     `;
}

export function completionBody(run: RunRow): string {
  return (run.title || run.prompt).replace(/\s+/g, " ").trim().slice(0, 120);
}

let marqueeTimer: ReturnType<typeof setInterval> | null = null;
let marqueeBuf = "";

export function stopTitleMarquee(): void {
  if (marqueeTimer != null) {
    clearInterval(marqueeTimer);
    marqueeTimer = null;
  }
  marqueeBuf = "";
  if (typeof document !== "undefined") document.title = BASE_TITLE;
}

export function startTitleMarquee(text: string): void {
  stopTitleMarquee();
  if (typeof document === "undefined") return;
  marqueeBuf = text.length >= 8 ? text : `${text}     `;
  document.title = marqueeBuf;
  marqueeTimer = setInterval(() => {
    if (!marqueeBuf) return;
    marqueeBuf = marqueeBuf.slice(1) + marqueeBuf[0];
    document.title = marqueeBuf;
  }, 380);
}

export function shouldAlert(run: RunRow, opts: { watchingId: string | null }): boolean {
  return opts.watchingId !== run.id;
}

function canNotify(): boolean {
  return typeof Notification !== "undefined";
}

export async function ensureNotifyPermission(): Promise<boolean> {
  if (!canNotify()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    if (localStorage.getItem(ASKED_KEY) === "1") return false;
    localStorage.setItem(ASKED_KEY, "1");
  } catch { /* ignore */ }
  try {
    const p = await Notification.requestPermission();
    return p === "granted";
  } catch {
    return false;
  }
}

export function showDesktopNotification(run: RunRow, onOpen?: (id: string) => void): void {
  if (!canNotify() || Notification.permission !== "granted") return;
  try {
    const title = pendingAskId(run) ? NEED_INPUT_TITLE
      : isAlertStatus(run.status) ? ALERT_TITLE[run.status] : ALERT_TITLE.completed;
    const n = new Notification(title, {
      body: pendingAskId(run) ? needInputBody(run) : completionBody(run),
      tag: pendingAskId(run) ? `armada-ask-${run.id}` : `armada-run-${run.id}`,
    });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      onOpen?.(run.id);
      n.close();
    };
  } catch { /* ignore */ }
}

export function alertNeedInput(
  runs: RunRow[],
  opts: { watchingId: string | null; tabVisible: boolean; desktop: boolean; onOpen?: (id: string) => void },
): void {
  const alertable = runs.filter((r) => shouldAlert(r, { watchingId: opts.watchingId }));
  if (alertable.length === 0) return;
  if (!opts.tabVisible) startTitleMarquee(`${NEED_INPUT_TITLE}     `);
  if (opts.desktop) {
    for (const r of alertable) {
      requestDesktopAlert({
        runId: r.id,
        machineId: r.machine_id,
        workspaceRoot: r.workspace_root,
        title: NEED_INPUT_TITLE,
        body: needInputBody(r),
      });
    }
    return;
  }
  void ensureNotifyPermission().then((ok) => {
    if (!ok) return;
    for (const r of alertable) showDesktopNotification(r, opts.onOpen);
  });
}

export function alertCompletions(
  runs: RunRow[],
  opts: { watchingId: string | null; tabVisible: boolean; desktop: boolean; onOpen?: (id: string) => void },
): void {
  const alertable = runs.filter((r) => shouldAlert(r, { watchingId: opts.watchingId }));
  if (alertable.length === 0) return;
  if (!opts.tabVisible) startTitleMarquee(completionHeadline(alertable));
  if (opts.desktop) {
    for (const r of alertable) {
      if (!isAlertStatus(r.status)) continue;
      requestDesktopAlert({
        runId: r.id,
        machineId: r.machine_id,
        workspaceRoot: r.workspace_root,
        title: ALERT_TITLE[r.status],
        body: completionBody(r),
      });
    }
    return;
  }
  void ensureNotifyPermission().then((ok) => {
    if (!ok) return;
    for (const r of alertable) showDesktopNotification(r, opts.onOpen);
  });
}
