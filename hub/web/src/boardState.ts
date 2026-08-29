export interface RunRow {
  id: string; machine_id: string; window_id: string | null; workspace_root: string;
  prompt: string; status: string; conversation_id: string | null;
  transcript_path: string | null; parent_run_id: string | null;
  created_at: number; started_at: number | null; ended_at: number | null; end_reason: string | null;
}

export type ColumnKey = "waiting" | "running" | "completed" | "cancelled" | "error";

const COLUMN_MAP: Record<string, ColumnKey> = {
  created: "waiting", dispatched: "waiting", binding: "waiting",
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
  const badge = COLUMN_LABELS[COLUMN_MAP[run.status] ?? "error"];
  return { title, elapsed, badge };
}
