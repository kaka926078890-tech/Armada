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
    <main className="flex-1 min-w-0 overflow-x-auto flex gap-2 p-3">
      {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((col) => (
        <section key={col} className={`w-60 shrink-0 flex flex-col rounded-lg bg-zinc-900/40 border-t-2 ${COL_ACCENT[col]}`}>
          <h2 className="text-[11px] tracking-wide uppercase text-zinc-500 px-2.5 pb-2 pt-2">
            {COLUMN_LABELS[col]} <span className="text-zinc-600 normal-case tracking-normal">{g[col].length}</span>
          </h2>
          <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 px-1.5 pb-2">
            {g[col].length === 0 && (
              <div className="text-[11px] text-zinc-700 px-2 py-6 text-center">—</div>
            )}
            {g[col].map((r) => {
              const v = cardView(r, now);
              return (
                <button key={r.id} onClick={() => onSelect(r.id)}
                  className={`text-left px-2.5 py-2 rounded-md border ${selected === r.id ? "border-sky-600/80 bg-zinc-900" : "border-transparent bg-zinc-900/50 hover:border-zinc-700"}`}>
                  <div className="text-[13px] font-medium leading-snug text-zinc-100">{v.title}</div>
                  <div className="text-[11px] text-zinc-500 mt-1">{nameOf(r.machine_id)} · {r.workspace_root.split("/").pop()}</div>
                  {r.status === "binding" && (
                    <div className="text-[11px] text-sky-500/80 mt-1">已提交,正在关联会话</div>
                  )}
                  {(r.status === "dispatched" || r.status === "created") && (
                    <div className="text-[11px] text-amber-500/80 mt-1">已预填,待本机回车</div>
                  )}
                  <div className="text-[11px] text-zinc-500 mt-1 flex justify-between">
                    <span className={BADGE_COLOR[col]}>{v.badge}</span><span className="text-zinc-600">{v.elapsed}</span>
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
