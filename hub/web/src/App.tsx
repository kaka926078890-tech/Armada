import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, clearToken, getToken, setToken } from "./api";
import { consumeQueryToken, isDesktopShell, searchWithoutToken } from "./tokenBootstrap";
import { requestDesktop, parseHostOpenRun } from "./desktopBridge";
import type { Machine } from "./types";
import type { RunRow } from "./boardState";
import {
  decodeWorkspaceKey, encodeWorkspaceKey, filterRunsByWorkspace, listWorkspaceSlots, sortConversations,
} from "./boardState";
import { applyAlertOpen } from "./alertOpen";
import Sidebar from "./components/Sidebar";
import Board from "./components/Board";
import RunDetail from "./components/RunDetail";
import { DispatchModal } from "./components/Modals";
import { alertCompletions, ensureNotifyPermission, seedRunStatus, stopTitleMarquee, takeNewlyAlertable } from "./completionNotify";
import { applyTheme, loadTheme, saveTheme, type ThemeName } from "./theme";

const WS_KEY = "armada.selectedWorkspace.v1";
const READ_KEY = "armada.readRuns.v1";
const READ_SEEDED = "armada.readRuns.seeded.v1";

function bootstrapTokenFromQuery(): string {
  const current = getToken();
  const { token, stripQuery } = consumeQueryToken(window.location.search, current);
  if (token && token !== current) setToken(token);
  if (stripQuery && typeof history !== "undefined" && window.location.search.includes("token=")) {
    const next = `${window.location.pathname}${searchWithoutToken(window.location.search)}${window.location.hash}`;
    history.replaceState(null, "", next);
  }
  return token || current;
}

function loadReadMap(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(READ_KEY) || "{}"); } catch { return {}; }
}

export default function App() {
  const [authed, setAuthed] = useState(() => !!bootstrapTokenFromQuery());
  const [machines, setMachines] = useState<Machine[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [hiddenRuns, setHiddenRuns] = useState<RunRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [selectedWs, setSelectedWs] = useState<string | null>(() => localStorage.getItem(WS_KEY));
  const [readMap, setReadMap] = useState<Record<string, number>>(loadReadMap);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [authDenied, setAuthDenied] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => loadTheme());

  const slots = useMemo(() => listWorkspaceSlots(machines), [machines]);
  const resolvedWs = useMemo(() => {
    if (selectedWs && slots.some((s) => encodeWorkspaceKey(s.machineId, s.root) === selectedWs)) return selectedWs;
    const first = slots.find((s) => s.online) ?? slots[0];
    return first ? encodeWorkspaceKey(first.machineId, first.root) : null;
  }, [slots, selectedWs]);
  const selected = decodeWorkspaceKey(resolvedWs);
  const boardSource = showArchived ? hiddenRuns : runs;
  const conversations = useMemo(() => {
    if (!selected) return [];
    return sortConversations(filterRunsByWorkspace(boardSource, selected.machineId, selected.root));
  }, [boardSource, selected?.machineId, selected?.root]);
  const boardRuns = conversations;

  const persistRead = useCallback((runId: string) => {
    setReadMap((prev) => {
      const next = { ...prev, [runId]: Date.now() };
      try { localStorage.setItem(READ_KEY, JSON.stringify(next)); } catch { /* quota / private */ }
      return next;
    });
  }, []);

  const selectWorkspace = useCallback((key: string) => {
    setSelectedWs(key);
    try { localStorage.setItem(WS_KEY, key); } catch { /* ignore */ }
    setSelectedRun(null);
  }, []);

  const openRun = useCallback((id: string) => {
    setSelectedRun(id);
    persistRead(id);
  }, [persistRead]);

  const openRunFromAlert = useCallback((alert: { runId: string; machineId: string; workspaceRoot: string }) => {
    const known = runs.some((r) => r.id === alert.runId) || hiddenRuns.some((r) => r.id === alert.runId);
    if (!known) return;
    const next = applyAlertOpen(alert);
    setShowArchived(next.showArchived);
    setSelectedWs(next.selectedWs);
    try { localStorage.setItem(WS_KEY, next.selectedWs); } catch { /* ignore */ }
    setSelectedRun(next.selectedRun);
    persistRead(next.selectedRun);
  }, [runs, hiddenRuns, persistRead]);

  const refresh = useCallback(() => {
    if (!authed) return;
    Promise.all([api.machines(), api.runs(), api.runs({ archived: true })])
      .then(([m, r, hidden]) => {
        setMachines(m);
        setRuns(Array.isArray(r) ? r : []);
        setHiddenRuns(Array.isArray(hidden) ? hidden : []);
        setLoadError("");
      })
      .catch((e) => {
        if (String(e).includes("unauthorized")) return;
        setLoadError("看板加载失败（hub 不可达）");
      });
  }, [authed]);

  useEffect(() => {
    const on401 = () => {
      localStorage.removeItem("armada.token");
      setAuthed(false);
      setAuthDenied(true);
    };
    window.addEventListener("armada:unauthorized", on401);
    return () => window.removeEventListener("armada:unauthorized", on401);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!authed) return;
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
    es.onmessage = () => refresh();
    return () => es.close();
  }, [authed, refresh]);

  useEffect(() => {
    if (runs.length === 0) return;
    if (localStorage.getItem(READ_SEEDED)) return;
    const seed: Record<string, number> = {};
    for (const r of runs) seed[r.id] = Date.now();
    try {
      localStorage.setItem(READ_KEY, JSON.stringify(seed));
      localStorage.setItem(READ_SEEDED, "1");
    } catch { /* ignore */ }
    setReadMap(seed);
  }, [runs]);

  useEffect(() => {
    if (!resolvedWs || resolvedWs === selectedWs) return;
    try { localStorage.setItem(WS_KEY, resolvedWs); } catch { /* ignore */ }
    setSelectedWs(resolvedWs);
  }, [resolvedWs, selectedWs]);

  const selectedEnded = runs.find((r) => r.id === selectedRun)?.ended_at ?? null;
  useEffect(() => {
    if (!selectedRun) return;
    persistRead(selectedRun);
  }, [selectedRun, selectedEnded, persistRead]);

  const seenStatus = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (runs.length === 0) return;
    if (!seenStatus.current) {
      seenStatus.current = seedRunStatus(runs);
      return;
    }
    const fresh = takeNewlyAlertable(seenStatus.current, runs);
    if (fresh.length === 0) return;
    alertCompletions(fresh, {
      watchingId: selectedRun,
      tabVisible: document.visibilityState === "visible",
      desktop: isDesktopShell(window.location.search),
      onOpen: openRun,
    });
  }, [runs, selectedRun, openRun]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") stopTitleMarquee();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", stopTitleMarquee);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", stopTitleMarquee);
      stopTitleMarquee();
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!isDesktopShell(window.location.search)) return;
    const onHost = (e: MessageEvent) => {
      const open = parseHostOpenRun(e.data, e.source, window.parent);
      if (!open) return;
      openRunFromAlert(open);
    };
    window.addEventListener("message", onHost);
    return () => window.removeEventListener("message", onHost);
  }, [openRunFromAlert]);

  useEffect(() => {
    if (!authed || isDesktopShell(window.location.search)) return;
    const once = () => { void ensureNotifyPermission(); };
    window.addEventListener("pointerdown", once, { once: true });
    return () => window.removeEventListener("pointerdown", once);
  }, [authed]);

  if (!authed) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
        <form className="flex flex-col gap-3 w-80" onSubmit={(e) => {
          e.preventDefault();
          const v = new FormData(e.currentTarget).get("token");
          if (typeof v === "string" && v.trim()) { setToken(v.trim()); setAuthDenied(false); setAuthed(true); }
        }}>
          <h1 className="text-xl font-bold">Armada 舰队指挥台</h1>
          <p className="text-[12px] text-zinc-500 leading-5">
            浏览器联调：先启动 hub，再粘贴 <code className="text-zinc-400">~/.armada/token</code>。创建/加入舰队请用桌面应用。
          </p>
          {authDenied && <div className="text-sm text-red-400">令牌无效，请重新从 hub 机器复制（cat ~/.armada/token)</div>}
          <input name="token" type="password" placeholder="配对令牌" className="px-3 py-2 rounded bg-zinc-900 border border-zinc-700" />
          <button className="px-3 py-2 rounded bg-sky-600 hover:bg-sky-500">连接</button>
        </form>
      </div>
    );
  }

  const desktop = isDesktopShell(window.location.search);
  const leaveFleet = () => {
    if (desktop) {
      requestDesktop("leave-fleet");
      return;
    }
    clearToken();
    setAuthed(false);
    setAuthDenied(false);
  };

  const preset = selected ? { machineId: selected.machineId, workspaceRoot: selected.root } : null;
  const presetSlot = selected ? slots.find((s) => s.machineId === selected.machineId && s.root === selected.root) : null;

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {loadError && (
        <div className="px-4 py-2 text-sm text-red-400 bg-red-950/50 border-b border-red-900/50">{loadError}</div>
      )}
      <header className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800/80">
        <span className="font-semibold text-[13px] tracking-wide">Armada</span>
        <span className="text-zinc-600 text-[12px]">{location.host}</span>
        <span className="text-[11px] text-emerald-500/90">令牌已连接</span>
        <button
          type="button"
          onClick={() => { setShowArchived((v) => !v); setSelectedRun(null); }}
          className={`text-[12px] px-2 py-0.5 rounded ${showArchived ? "bg-amber-900/60 text-amber-200" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          {showArchived ? "返回看板" : `查看已隐藏${hiddenRuns.length ? ` ${hiddenRuns.length}` : ""}`}
        </button>
        <span className="ml-auto flex items-center gap-3 text-[12px] text-zinc-500">
          在线 {machines.filter((m) => m.status === "online").length}/{machines.length}
          <button
            type="button"
            aria-label="切换明亮/黑夜"
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              saveTheme(next);
              setTheme(next);
            }}
            className="text-zinc-400 hover:text-zinc-100 px-2 py-0.5 rounded border border-zinc-700"
          >
            {theme === "dark" ? "明亮" : "黑夜"}
          </button>
          <button
            type="button"
            onClick={leaveFleet}
            className="text-zinc-400 hover:text-zinc-100 px-2 py-0.5 rounded border border-zinc-700"
          >
            退出中台
          </button>
        </span>
      </header>
      <div className="flex flex-1 min-h-0">
        <Sidebar
          slots={slots}
          machines={machines}
          allRuns={runs}
          selectedKey={resolvedWs}
          onSelectWorkspace={selectWorkspace}
          readMap={readMap}
          onDispatch={() => { if (preset) setDispatchOpen(true); }}
          onRename={(id, displayName) => { api.renameMachine(id, displayName).then(refresh); }}
          showDesktopActions={desktop}
          onOpenWorkspace={() => requestDesktop("open-workspace")}
          onGetShareLink={() => requestDesktop("get-share-link")}
        />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {showArchived && (
            <div className="px-4 py-1.5 text-[12px] text-amber-200/90 bg-amber-950/40 border-b border-amber-900/40">
              正在查看中台已隐藏的卡片（数据未删除，可取消隐藏）
            </div>
          )}
          <Board
            runs={boardRuns}
            machines={machines}
            selected={selectedRun}
            onSelect={openRun}
            showArchived={showArchived}
            readMap={readMap}
            onHide={(id) => { api.archive(id).then(() => { setSelectedRun((cur) => cur === id ? null : cur); refresh(); }); }}
            onUnhide={(id) => { api.unarchive(id).then(refresh); }}
          />
        </div>
      </div>
      {selectedRun && (
        <div className="fixed inset-0 z-40">
          <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" aria-label="关闭详情" onClick={() => setSelectedRun(null)} />
          <div className="absolute inset-y-0 right-0 flex pointer-events-none">
            <div className="pointer-events-auto h-full min-h-0">
              <RunDetail runId={selectedRun} onClose={() => setSelectedRun(null)} onChanged={refresh} />
            </div>
          </div>
        </div>
      )}
      {dispatchOpen && preset && (
        <DispatchModal
          machines={machines}
          preset={preset}
          presetLabel={`${presetSlot?.machineName ?? preset.machineId} · ${preset.workspaceRoot.split("/").pop()}`}
          activeOnWorkspace={filterRunsByWorkspace(runs, preset.machineId, preset.workspaceRoot)
            .filter((r) => ["queued", "dispatched", "binding", "running"].includes(r.status)).length}
          onClose={() => setDispatchOpen(false)}
          onDone={() => { setDispatchOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}
