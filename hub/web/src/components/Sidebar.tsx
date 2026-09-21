import { useState } from "react";
import type { Machine } from "../types";
import type { RunRow } from "../boardState";
import {
  encodeWorkspaceKey, extensionLagNotice, filterRunsByWorkspace, formatUnreadCount, groupSlotsByMachine,
  reloadPendingForMachine, workspaceFolderName, workspaceHasLiveRun, workspaceUnreadCount,
  type CursorReloadPendingView, type WorkspaceSlot,
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

function ReloadChrome({
  machineId, pendingAction, busyAction, onReload,
}: {
  machineId: string;
  pendingAction: "now" | "when-idle" | null;
  busyAction?: "now" | "when-idle" | "skip";
  onReload: (machineId: string, action: "now" | "when-idle" | "skip") => void;
}) {
  const wait = !!busyAction;
  const phase = busyAction && busyAction !== "skip" ? busyAction : pendingAction;
  const skipping = busyAction === "skip";
  if (phase || skipping) {
    const label = skipping ? "正在跳过…" : phase === "now" ? "正在 Reload…" : "空闲后 Reload…";
    return (
      <div className="mx-3 mb-1 rounded-md border border-sky-500/25 bg-sky-500/10 px-2 py-1.5 flex items-center gap-1.5">
        <LiveSpinner />
        <span className={`${UI_META} text-sky-400 min-w-0 flex-1 truncate`} title={label}>{label}</span>
        {skipping ? null : (
          <Button type="button" size="xs" variant="ghost" disabled={wait} onClick={() => onReload(machineId, "skip")}>
            取消
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="mx-3 mb-1 rounded-md border border-amber-500/25 bg-amber-500/10 p-1">
      <div className={`${UI_META} text-amber-400 px-1 pb-1`}>扩展待 Reload</div>
      <div className="grid grid-cols-3 gap-1">
        <Button type="button" size="xs" className="min-w-0 px-1" disabled={wait} aria-label="现在 Reload" title="现在 Reload" onClick={() => onReload(machineId, "now")}>立即</Button>
        <Button type="button" size="xs" variant="outline" className="min-w-0 px-1" disabled={wait} aria-label="空闲后自动" title="空闲后自动" onClick={() => onReload(machineId, "when-idle")}>空闲后</Button>
        <Button type="button" size="xs" variant="ghost" className="min-w-0 px-1" disabled={wait} aria-label="这次跳过" title="这次跳过" onClick={() => onReload(machineId, "skip")}>跳过</Button>
      </div>
    </div>
  );
}

export default function Sidebar({
  slots, machines, allRuns, selectedKey, onSelectWorkspace, readMap, onDispatch, onRename,
  showDesktopActions, onOpenWorkspace, onRepairCdp, onGetShareLink, onReloadMachine, reloadMachineIds,
  reloadPending, reloadBusy, requiredVsix, packNotice,
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
  reloadPending?: CursorReloadPendingView | null;
  reloadBusy?: Record<string, "now" | "when-idle" | "skip">;
  requiredVsix?: string;
  packNotice?: string | null;
}) {
  const groups = groupSlotsByMachine(slots);
  const selected = slots.find((s) => encodeWorkspaceKey(s.machineId, s.root) === selectedKey);
  const canDispatch = !!selected?.online && selected.cdpReady;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const hostOf = (id: string) => machines.find((m) => m.id === id)?.name ?? "";
  const lagOf = (id: string) => packNotice
    ? null
    : extensionLagNotice(machines.find((m) => m.id === id)?.extension_version, requiredVsix);

  const commit = (machineId: string) => {
    onRename(machineId, draft.trim());
    setEditingId(null);
  };

  return (
    <aside className="relative z-50 w-[224px] shrink-0 border-r border-border flex flex-col bg-sidebar text-sidebar-foreground overflow-x-hidden">
      {showDesktopActions ? (
        <div className="mx-3 mt-3 mb-1.5 grid grid-cols-3 gap-1">
          <Button type="button" size="xs" variant="outline" className="min-w-0 px-1" title="打开工作区" aria-label="打开工作区" onClick={onOpenWorkspace}>
            打开
          </Button>
          <Button type="button" size="xs" variant="outline" className="min-w-0 px-1" title="修复调试口" aria-label="修复调试口" onClick={onRepairCdp}>
            调试口
          </Button>
          <Button type="button" size="xs" variant="outline" className="min-w-0 px-1" title="获取分享链接" aria-label="获取分享链接" onClick={onGetShareLink}>
            分享
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
      {packNotice ? (
        <div className={`px-3 pb-2 ${UI_META} text-amber-400 leading-snug`}>{packNotice}</div>
      ) : null}
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
            {g.online && !packNotice && onReloadMachine && (reloadMachineIds?.includes(g.machineId) || reloadBusy?.[g.machineId]) ? (
              <ReloadChrome
                machineId={g.machineId}
                pendingAction={reloadPendingForMachine(reloadPending, g.machineId, !!reloadMachineIds?.includes(g.machineId))}
                busyAction={reloadBusy?.[g.machineId]}
                onReload={onReloadMachine}
              />
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
