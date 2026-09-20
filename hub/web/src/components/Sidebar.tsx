import { useState } from "react";
import type { Machine } from "../types";
import type { RunRow } from "../boardState";
import {
  encodeWorkspaceKey, extensionLagNotice, filterRunsByWorkspace, formatUnreadCount, groupSlotsByMachine,
  workspaceFolderName, workspaceHasLiveRun, workspaceUnreadCount, type WorkspaceSlot,
} from "../boardState";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { UI_META, UI_TYPE } from "../ui";

function UnreadCount({ n }: { n: number }) {
  const label = formatUnreadCount(n);
  if (!label) return null;
  return (
    <span
      className="ml-auto shrink-0 min-w-[1.125rem] h-[1.125rem] px-1 rounded-full bg-red-500 text-white text-[12px] font-medium leading-[1.125rem] text-center tabular-nums"
      title={`${n} 个终态未读`}
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

function LiveSpinner() {
  return (
    <span
      className="size-3 shrink-0 rounded-full border-[1.5px] border-sky-500/30 border-t-sky-400 animate-spin"
      role="img"
      aria-label="任务执行中"
      title="任务执行中"
    />
  );
}

export default function Sidebar({
  slots, machines, allRuns, selectedKey, onSelectWorkspace, readMap, onDispatch, onRename,
  showDesktopActions, onOpenWorkspace, onRepairCdp, onGetShareLink, onReloadMachine, reloadMachineIds,
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
  onRepairCdp?: () => void;
  onGetShareLink?: () => void;
  onReloadMachine?: (machineId: string, action: "now" | "when-idle" | "skip") => void;
  reloadMachineIds?: string[];
}) {
  const groups = groupSlotsByMachine(slots);
  const selected = slots.find((s) => encodeWorkspaceKey(s.machineId, s.root) === selectedKey);
  const canDispatch = !!selected?.online && selected.cdpReady;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const hostOf = (id: string) => machines.find((m) => m.id === id)?.name ?? "";
  const lagOf = (id: string) => extensionLagNotice(machines.find((m) => m.id === id)?.extension_version);

  const commit = (machineId: string) => {
    onRename(machineId, draft.trim());
    setEditingId(null);
  };

  return (
    <aside className="w-[224px] shrink-0 border-r border-border flex flex-col bg-sidebar text-sidebar-foreground overflow-x-hidden">
      {showDesktopActions ? (
        <div className="mx-3 mt-3 mb-1.5 flex flex-col gap-1.5">
          <Button type="button" variant="outline" className="w-full" onClick={onOpenWorkspace}>
            打开工作区
          </Button>
          <Button type="button" variant="outline" className="w-full" onClick={onRepairCdp}>
            修复调试口
          </Button>
          <Button type="button" variant="outline" className="w-full" onClick={onGetShareLink}>
            获取分享链接
          </Button>
        </div>
      ) : null}
      <Button
        type="button"
        disabled={!canDispatch}
        onClick={onDispatch}
        className={`mx-3 mb-1 w-[calc(100%-1.5rem)] ${showDesktopActions ? "mt-0" : "mt-3"}`}
      >
        + 派发任务
      </Button>
      <div className={`px-3 pt-1.5 pb-1 ${UI_META} uppercase tracking-wide text-muted-foreground`}>机器</div>
      <ScrollArea className="flex-1">
        {groups.length === 0 && (
          <div className={`px-3 py-4 ${UI_META} text-muted-foreground`}>暂无在线工作区</div>
        )}
        {groups.map((g) => {
          const lag = lagOf(g.machineId);
          return (
          <div key={g.machineId} className="pb-2">
            <div className="group px-3 py-1.5 flex items-center gap-2">
              <span className={g.online ? "text-emerald-400 text-[12px]" : "text-muted-foreground text-[12px]"}>●</span>
              {editingId === g.machineId ? (
                <Input
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
                  className={`min-w-0 flex-1 ${UI_TYPE} font-medium`}
                />
              ) : (
                <>
                  <span className={`min-w-0 flex-1 ${UI_TYPE} font-medium truncate`} title={g.machineName}>{g.machineName}</span>
                  <button
                    type="button"
                    aria-label="重命名电脑"
                    onClick={() => { setEditingId(g.machineId); setDraft(g.machineName); }}
                    className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 shrink-0"
                  >
                    <PencilIcon />
                  </button>
                </>
              )}
            </div>
            {lag ? (
              <div className={`pl-7 pr-3 pb-1 ${UI_META} text-amber-400 leading-snug`}>{lag}</div>
            ) : null}
            {g.online && (lag || reloadMachineIds?.includes(g.machineId)) && onReloadMachine ? (
              <div className="pl-7 pr-3 pb-1 flex flex-wrap gap-1">
                <Button type="button" size="sm" className="whitespace-nowrap" onClick={() => onReloadMachine(g.machineId, "now")}>现在 Reload</Button>
                <Button type="button" size="sm" variant="outline" className="whitespace-nowrap" onClick={() => onReloadMachine(g.machineId, "when-idle")}>空闲后自动</Button>
                <Button type="button" size="sm" variant="ghost" className="whitespace-nowrap" onClick={() => onReloadMachine(g.machineId, "skip")}>这次跳过</Button>
              </div>
            ) : null}
            {g.workspaces.map((s) => {
              const key = encodeWorkspaceKey(s.machineId, s.root);
              const wsRuns = filterRunsByWorkspace(allRuns, s.machineId, s.root);
              const unread = workspaceUnreadCount(wsRuns, readMap);
              const live = workspaceHasLiveRun(wsRuns);
              return (
                <button
                  key={key}
                  onClick={() => onSelectWorkspace(key)}
                  className={`w-full text-left pl-7 pr-3 py-1 flex items-center gap-1.5 ${key === selectedKey ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50 text-muted-foreground"}`}
                >
                  <span className="text-muted-foreground text-[12px] shrink-0">–</span>
                  <span className="min-w-0 flex-1 flex items-center gap-1.5">
                    <span className={`min-w-0 truncate ${UI_TYPE}`} title={s.root}>{workspaceFolderName(s.root)}</span>
                    {live ? <LiveSpinner /> : null}
                  </span>
                  <UnreadCount n={unread} />
                </button>
              );
            })}
          </div>
          );
        })}
      </ScrollArea>
    </aside>
  );
}
