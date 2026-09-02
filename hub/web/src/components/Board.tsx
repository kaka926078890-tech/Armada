import { groupRuns, cardView, COLUMN_LABELS, canArchiveRun, isUnreadCompleted, type ColumnKey, type RunRow } from "../boardState";
import type { Machine } from "../types";
import { machineLabel } from "../boardState";

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

export default function Board({ runs, machines, selected, onSelect, showArchived, onHide, onUnhide, readMap }: {
  runs: RunRow[]; machines: Machine[]; selected: string | null; onSelect: (id: string) => void;
  showArchived: boolean;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  readMap: Record<string, number>;
}) {
  const g = groupRuns(runs);
  const now = Date.now();
  const nameOf = (id: string) => {
    const m = machines.find((x) => x.id === id);
    return m ? machineLabel(m) : id;
  };
  return (
    <main className="flex-1 min-w-0 overflow-x-auto flex gap-2 p-3">
      {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((col) => (
        <section key={col} className={`w-60 min-w-60 max-w-60 shrink-0 flex flex-col rounded-lg bg-zinc-900/40 border-t-2 ${COL_ACCENT[col]}`}>
          <h2 className="text-[11px] tracking-wide uppercase text-zinc-500 px-2.5 pb-2 pt-2">
            {COLUMN_LABELS[col]} <span className="text-zinc-600 normal-case tracking-normal">{g[col].length}</span>
          </h2>
          <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 px-1.5 pb-2">
            {g[col].length === 0 && (
              <div className="text-[11px] text-zinc-700 px-2 py-6 text-center">—</div>
            )}
            {g[col].map((r) => {
              const v = cardView(r, now);
              const unread = isUnreadCompleted(r, readMap[r.id]);
              return (
                <div key={r.id} className={`group relative min-w-0 text-left rounded-md border ${selected === r.id ? "border-sky-600/80 bg-zinc-900" : "border-transparent bg-zinc-900/50 hover:border-zinc-700"}`}>
                  <button onClick={() => onSelect(r.id)} className="w-full min-w-0 text-left px-2.5 py-2">
                    <div className="text-[13px] font-medium leading-snug text-zinc-100 pr-10 break-all">{v.title}</div>
                    <div className="text-[11px] text-zinc-500 mt-1 truncate">{nameOf(r.machine_id)} · {r.workspace_root.split("/").pop()}</div>
                    {r.status === "binding" && (
                      <div className="text-[11px] text-sky-500/80 mt-1">已提交,正在关联会话</div>
                    )}
                    {(r.status === "dispatched" || r.status === "created") && (
                      <div className="text-[11px] text-amber-500/80 mt-1">已预填,待本机回车</div>
                    )}
                    <div className="text-[11px] text-zinc-500 mt-1 flex justify-between items-center">
                      <span className={`inline-flex items-center gap-1.5 ${BADGE_COLOR[col]}`}>
                        {unread ? <span className="size-1.5 shrink-0 rounded-full bg-red-500" title="完成未读" /> : null}
                        {v.badge}
                      </span>
                      <span className="text-zinc-600">{v.elapsed}</span>
                    </div>
                  </button>
                  {showArchived ? (
                    <button type="button" onClick={(e) => { e.stopPropagation(); onUnhide(r.id); }}
                      className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 opacity-0 group-hover:opacity-100">
                      取消隐藏
                    </button>
                  ) : canArchiveRun(r) ? (
                    <button type="button" onClick={(e) => { e.stopPropagation(); onHide(r.id); }}
                      className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 opacity-0 group-hover:opacity-100">
                      隐藏
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
