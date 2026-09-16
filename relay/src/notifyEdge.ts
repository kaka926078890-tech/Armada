export const NEED_INPUT_TITLE = "Armada 需要你处理";

export const ALERT_STATUSES = ["completed", "error", "unknown", "aborted"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_TITLE: Record<AlertStatus, string> = {
  completed: "Armada 任务完成",
  error: "Armada 任务失败",
  unknown: "Armada 任务异常",
  aborted: "Armada 任务已中止",
};

export type NotifyKind = "ask" | AlertStatus;

export type NotifyEdge = {
  kind: NotifyKind;
  title: string;
  body: string;
};

export type NotifyPrev = {
  notifiedStatus: string | null;
  notifiedAskId: string | null;
};

export type NotifySnap = {
  runId?: string;
  prompt?: string;
  status: string;
  pendingAsk?: unknown;
};

export function isAlertStatus(s: string): s is AlertStatus {
  return (ALERT_STATUSES as readonly string[]).includes(s);
}

export function askIdOf(pending: unknown): string | null {
  if (!pending || typeof pending !== "object") return null;
  const id = (pending as { request_id?: unknown }).request_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function clip120(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function askBody(snap: NotifySnap): string {
  const pending = snap.pendingAsk;
  if (pending && typeof pending === "object") {
    const qs = (pending as { questions?: unknown }).questions;
    const first = Array.isArray(qs) ? qs[0] : null;
    const prompt = first && typeof first === "object" ? (first as { prompt?: unknown }).prompt : null;
    if (typeof prompt === "string" && prompt.trim()) return clip120(prompt);
  }
  return clip120(snap.prompt ?? "");
}

export function terminalBody(snap: NotifySnap): string {
  return clip120(snap.prompt ?? "");
}

export function notifyEdges(prev: NotifyPrev, snap: NotifySnap): {
  edges: NotifyEdge[];
  notifiedStatus: string | null;
  notifiedAskId: string | null;
} {
  const edges: NotifyEdge[] = [];
  const nextAsk = askIdOf(snap.pendingAsk);
  if (nextAsk && nextAsk !== prev.notifiedAskId) {
    edges.push({ kind: "ask", title: NEED_INPUT_TITLE, body: askBody(snap) });
  }

  let notifiedStatus: string | null;
  if (!isAlertStatus(snap.status)) {
    notifiedStatus = null;
  } else if (prev.notifiedStatus == null || !isAlertStatus(prev.notifiedStatus)) {
    edges.push({
      kind: snap.status,
      title: ALERT_TITLE[snap.status],
      body: terminalBody(snap),
    });
    notifiedStatus = snap.status;
  } else {
    notifiedStatus = prev.notifiedStatus;
  }

  return { edges, notifiedStatus, notifiedAskId: nextAsk };
}
