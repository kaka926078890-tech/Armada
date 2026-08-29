import { groupRuns, cardView, COLUMN_LABELS, type ColumnKey, type RunRow } from "../boardState";
import type { Machine } from "../types";

const COL_ACCENT: Record<ColumnKey, string> = {
  waiting: "border-t-amber-500",
  running: "border-t-sky-500",
  completed: "border-t-emerald-500",
  cancelled: "border-t-zinc-500",
  error: "border-t-red-500",
};

const BADGE_COLOR: Record<ColumnKey, string> = {
  waiting: "text-amber-400",
  running: "text-sky-400 animate-pulse",
  completed: "text-emerald-400",
  cancelled: "text-zinc-500",
  error: "text-red-400",
};

export default function Board({ runs, machines, selected, onSelect }: {
  runs: RunRow[]; machines: Machine[]; selected: string | null; onSelect: (id: string) => void;
}) {
  const g = groupRuns(runs);
  const now = Date.now();
  const nameOf = (id: string) => machines.find((m) => m.id === id)?.name ?? id;
  return (
    <main className="flex-1 min-w-0 overflow-x-auto flex gap-3 p-3">
      {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((col) => (
        <section key={col} className={`w-64 shrink-0 flex flex-col border-t-2 ${COL_ACCENT[col]}`}>
          <h2 className="text-sm text-zinc-400 px-1 pb-2 pt-1">{COLUMN_LABELS[col]} <span className="text-zinc-600">{g[col].length}</span></h2>
          <div className="flex-1 overflow-y-auto flex flex-col gap-2">
            {g[col].map((r) => {
              const v = cardView(r, now);
              return (
                <button key={r.id} onClick={() => onSelect(r.id)}
                  className={`text-left p-3 rounded border ${selected === r.id ? "border-sky-500 bg-zinc-900" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-600"}`}>
                  <div className="text-sm font-medium">{v.title}</div>
                  <div className="text-xs text-zinc-500 mt-1">{nameOf(r.machine_id)} · {r.workspace_root.split("/").pop()}</div>
                  {col === "waiting" && (
                    <div className="text-xs text-amber-500/80 mt-1">已在 {nameOf(r.machine_id)} 预填,待本机回车</div>
                  )}
                  <div className="text-xs text-zinc-400 mt-1 flex justify-between">
                    <span className={BADGE_COLOR[col]}>{v.badge}</span><span>{v.elapsed}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
