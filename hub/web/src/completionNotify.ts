import type { RunRow } from "./boardState";

export const BASE_TITLE = "Armada";
const ASKED_KEY = "armada.notifyAsked.v1";

/** 把 prev 推进到当前 runs，返回本次新变成 completed 的卡片。首次调用前应先 seed。 */
export function takeNewlyCompleted(prev: Map<string, string>, runs: RunRow[]): RunRow[] {
  const out: RunRow[] = [];
  for (const r of runs) {
    const last = prev.get(r.id);
    if (r.status === "completed" && last != null && last !== "completed") out.push(r);
    prev.set(r.id, r.status);
  }
  return out;
}

export function seedRunStatus(runs: RunRow[]): Map<string, string> {
  return new Map(runs.map((r) => [r.id, r.status]));
}

export function completionHeadline(runs: RunRow[]): string {
  if (runs.length === 0) return BASE_TITLE;
  if (runs.length === 1) {
    const t = runs[0].prompt.replace(/\s+/g, " ").trim().slice(0, 40);
    return `【完成】${t} — ${BASE_TITLE}     `;
  }
  return `【${runs.length} 个任务完成】${BASE_TITLE}     `;
}

export function completionBody(run: RunRow): string {
  return run.prompt.replace(/\s+/g, " ").trim().slice(0, 120);
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

export function shouldAlert(run: RunRow, opts: { watchingId: string | null; tabVisible: boolean }): boolean {
  if (opts.tabVisible && opts.watchingId === run.id) return false;
  return true;
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
    const n = new Notification("Armada 任务完成", {
      body: completionBody(run),
      tag: `armada-run-${run.id}`,
    });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      onOpen?.(run.id);
      n.close();
    };
  } catch { /* ignore */ }
}

export function alertCompletions(
  runs: RunRow[],
  opts: { watchingId: string | null; tabVisible: boolean; onOpen?: (id: string) => void },
): void {
  const alertable = runs.filter((r) => shouldAlert(r, opts));
  if (alertable.length === 0) return;
  if (!opts.tabVisible) startTitleMarquee(completionHeadline(alertable));
  void ensureNotifyPermission().then((ok) => {
    if (!ok) return;
    for (const r of alertable) showDesktopNotification(r, opts.onOpen);
  });
}
