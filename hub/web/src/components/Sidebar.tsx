import { useState } from "react";
import type { Machine } from "../types";
import type { RunRow } from "../boardState";
import {
  encodeWorkspaceKey, filterRunsByWorkspace, formatUnreadCount, groupSlotsByMachine,
  workspaceUnreadCount, type WorkspaceSlot,
} from "../boardState";

function UnreadCount({ n }: { n: number }) {
  const label = formatUnreadCount(n);
  if (!label) return null;
  return (
    <span
      className="ml-auto shrink-0 min-w-[1.125rem] h-[1.125rem] px-1 rounded-full bg-red-500 text-white text-[11px] font-medium leading-[1.125rem] text-center tabular-nums"
      title={`${n} 个完成未读`}
    >
      {label}
    </span>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M11.2 2.4l2.4 2.4L5.2 13H2.8v-2.4L11.2 2.4z" />
      <path d="M9.6 4l2.4 2.4" />
    </svg>
  );
}

export default function Sidebar({
  slots, machines, allRuns, selectedKey, onSelectWorkspace, readMap, onDispatch, onRename,
  showDesktopActions, onOpenWorkspace, onGetShareLink,
}: {
  slots: WorkspaceSlot[];
  machines: Machine[];
  allRuns: RunRow[];
  selectedKey: string | null;
  onSelectWorkspace: (key: string) => void;
  readMap: Record<string, number>;
  onDispatch: () => void;
  onRename: (machineId: string, displayName: string) => void;
  showDesktopActions?: boolean;
  onOpenWorkspace?: () => void;
  onGetShareLink?: () => void;
}) {
  const groups = groupSlotsByMachine(slots);
  const selected = slots.find((s) => encodeWorkspaceKey(s.machineId, s.root) === selectedKey);
  const canDispatch = !!selected?.online;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const hostOf = (id: string) => machines.find((m) => m.id === id)?.name ?? "";

  const commit = (machineId: string) => {
    onRename(machineId, draft.trim());
    setEditingId(null);
  };

  return (
    <aside className="w-56 shrink-0 border-r border-zinc-800/80 flex flex-col bg-zinc-950">
      {showDesktopActions ? (
        <div className="mx-3 mt-3 mb-1.5 flex flex-col gap-1.5">
          <button
            type="button"
            onClick={onOpenWorkspace}
            className="px-3 py-2 rounded-md border border-zinc-700 hover:bg-zinc-900 text-[13px]"
          >
            打开工作区
          </button>
          <button
            type="button"
            onClick={onGetShareLink}
            className="px-3 py-2 rounded-md border border-zinc-700 hover:bg-zinc-900 text-[13px]"
          >
            获取分享链接
          </button>
        </div>
      ) : null}
      <button
        type="button"
        disabled={!canDispatch}
        onClick={onDispatch}
        className={`mx-3 mb-1 px-3 py-2 rounded-md bg-sky-700 hover:bg-sky-600 text-[13px] disabled:opacity-40 disabled:hover:bg-sky-700 ${showDesktopActions ? "mt-0" : "mt-3"}`}
      >
        + 派发任务
      </button>
      <div className="px-3 pt-1.5 pb-1 text-[11px] uppercase tracking-wide text-zinc-600">机器</div>
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-zinc-600">暂无在线工作区</div>
        )}
        {groups.map((g) => (
          <div key={g.machineId} className="pb-2">
            <div className="group px-3 py-1.5 flex items-center gap-2">
              <span className={g.online ? "text-emerald-400 text-[10px]" : "text-zinc-600 text-[10px]"}>●</span>
              {editingId === g.machineId ? (
                <input
                  autoFocus
                  value={draft}
                  maxLength={40}
                  placeholder={hostOf(g.machineId)}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commit(g.machineId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commit(g.machineId); }
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="min-w-0 flex-1 text-[13px] font-medium bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5"
                />
              ) : (
                <>
                  <span className="min-w-0 flex-1 text-[13px] font-medium truncate" title={g.machineName}>{g.machineName}</span>
                  <button
                    type="button"
                    aria-label="重命名电脑"
                    onClick={() => { setEditingId(g.machineId); setDraft(g.machineName); }}
                    className="text-zinc-500 hover:text-zinc-200 opacity-0 group-hover:opacity-100 shrink-0"
                  >
                    <PencilIcon />
                  </button>
                </>
              )}
            </div>
            {g.workspaces.map((s) => {
              const key = encodeWorkspaceKey(s.machineId, s.root);
              const wsRuns = filterRunsByWorkspace(allRuns, s.machineId, s.root);
              const unread = workspaceUnreadCount(wsRuns, readMap);
              return (
                <button
                  key={key}
                  onClick={() => onSelectWorkspace(key)}
                  className={`w-full text-left pl-7 pr-3 py-1 flex items-center gap-1.5 ${key === selectedKey ? "bg-zinc-900 text-zinc-100" : "hover:bg-zinc-900/50 text-zinc-400"}`}
                >
                  <span className="text-zinc-600 text-[11px] shrink-0">–</span>
                  <span className="min-w-0 flex-1 text-[13px] truncate" title={s.root}>{s.root.split("/").pop()}</span>
                  <UnreadCount n={unread} />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
