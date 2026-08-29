import type { Machine } from "../types";
import type { RunRow } from "../boardState";

export default function Sidebar({ machines, runs, onDispatch }: {
  machines: Machine[]; runs: RunRow[]; onDispatch: () => void;
}) {
  return (
    <aside className="w-56 shrink-0 border-r border-zinc-800 flex flex-col">
      <div className="px-3 py-2 text-xs text-zinc-400">机器</div>
      <div className="flex-1 overflow-y-auto">
        {machines.map((m) => {
          const active = runs.filter((r) => r.machine_id === m.id && ["dispatched", "binding", "running"].includes(r.status)).length;
          let workspaces: string[] = [];
          try { workspaces = JSON.parse(m.open_workspaces || "[]"); } catch { workspaces = []; }
          return (
            <div key={m.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={m.status === "online" ? "text-emerald-400" : "text-zinc-600"}>●</span>
                <span className="font-medium">{m.name}</span>
                {active > 0 && <span className="ml-auto text-xs bg-sky-900 px-1.5 rounded">{active}</span>}
              </div>
              <div className="ml-4 text-xs text-zinc-500">{m.os}</div>
              {workspaces.map((w: string) => (
                <div key={w} className="ml-4 text-xs text-zinc-400 truncate" title={w}>└ {w.split("/").pop()}</div>
              ))}
            </div>
          );
        })}
      </div>
      <button onClick={onDispatch} className="m-3 px-3 py-2 rounded bg-sky-600 hover:bg-sky-500 text-sm">+ 派发任务</button>
    </aside>
  );
}
