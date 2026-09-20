import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, clearToken, getToken, setToken } from "./api";
import { consumeQueryToken, isDesktopShell, searchWithoutToken } from "./tokenBootstrap";
import { requestDesktop, parseHostOpenRun } from "./desktopBridge";
import { decideAuthLoss } from "./authSession";
import type { Machine } from "./types";
import type { RunRow } from "./boardState";
import {
  decodeWorkspaceKey, encodeWorkspaceKey, filterRunsByWorkspace, listWorkspaceSlots, sortConversations,
  workspaceFolderName, resolveSelectedWorkspace,
  BOARD_SSE_DEBOUNCE_MS, boardSseShouldRefresh,
} from "./boardState";
import { applyAlertOpen } from "./alertOpen";
import Sidebar from "./components/Sidebar";
import Board from "./components/Board";
import RunDetail from "./components/RunDetail";
import { DispatchModal } from "./components/Modals";
import { alertCompletions, alertNeedInput, ensureNotifyPermission, seedAskStatus, seedRunStatus, stopTitleMarquee, takeNewlyAlertable, takeNewlyNeedInput } from "./completionNotify";
import { applyFontScale, applyTheme, loadFontScale, loadTheme, saveFontScale, saveTheme, type FontScale, type ThemeName } from "./theme";
import SettingsModal from "./components/SettingsModal";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { UI_META, UI_TYPE } from "./ui";
import {
  WS_KEY, READ_KEY, READ_SEEDED,
  loadLocalUiPrefsMirror, applyUiPrefsToLocalStorage,
  shouldMigrateLocal, shouldSeedReadRuns,
  type UiPrefs, type UiPrefsGetResponse, type PromptSnippet,
} from "./uiPrefs";
import { snippetOperatorMessage } from "./promptSnippets";

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
  const [selectedWs, setSelectedWs] = useState<string | null>(() => {
    try { return localStorage.getItem(WS_KEY); } catch { return null; }
  });
  const [readMap, setReadMap] = useState<Record<string, number>>(loadReadMap);
  const [readRunsSeeded, setReadRunsSeeded] = useState(() => {
    try { return localStorage.getItem(READ_SEEDED) === "1"; } catch { return false; }
  });
  const [prefsReady, setPrefsReady] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [authDenied, setAuthDenied] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => loadTheme());
  const [fontScale, setFontScale] = useState<FontScale>(() => loadFontScale());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [snippets, setSnippets] = useState<PromptSnippet[]>([]);
  const [snippetError, setSnippetError] = useState("");
  const [cursorReload, setCursorReload] = useState<{ needed: boolean; neededMachineIds: string[] }>({ needed: false, neededMachineIds: [] });
  const desktop = isDesktopShell(window.location.search);
  const askedHost = useRef(false);
  const readMapRef = useRef(readMap);
  readMapRef.current = readMap;
  const readPatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const slots = useMemo(() => listWorkspaceSlots(machines), [machines]);
  const selectedRunRow = useMemo(() => {
    if (!selectedRun) return null;
    return runs.find((r) => r.id === selectedRun) ?? hiddenRuns.find((r) => r.id === selectedRun) ?? null;
  }, [selectedRun, runs, hiddenRuns]);
  const resolvedWs = useMemo(
    () => resolveSelectedWorkspace(slots, selectedWs, selectedRunRow),
    [slots, selectedWs, selectedRunRow],
  );
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
      readMapRef.current = next;
      return next;
    });
    if (readPatchTimer.current) clearTimeout(readPatchTimer.current);
    readPatchTimer.current = setTimeout(() => {
      void api.putUiPrefs({ readRuns: readMapRef.current }).catch(() => {});
    }, 300);
  }, []);

  const reloadSnippets = useCallback(() => {
    void api.getPromptSnippets()
      .then((r) => {
        setSnippets(Array.isArray(r.snippets) ? r.snippets : []);
        setSnippetError("");
      })
      .catch(() => {
        setSnippets([]);
        setSnippetError(snippetOperatorMessage("READ_FAIL"));
      });
  }, []);

  const saveSnippets = useCallback(async (next: PromptSnippet[]) => {
    const prev = snippets;
    setSnippets(next);
    try {
      const r = await api.putPromptSnippets(next);
      setSnippets(Array.isArray(r.snippets) ? r.snippets : next);
      setSnippetError("");
    } catch (e) {
      setSnippets(prev);
      throw e;
    }
  }, [snippets]);

  useEffect(() => { if (authed) reloadSnippets(); }, [authed, reloadSnippets]);

  const selectWorkspace = useCallback((key: string) => {
    setSelectedWs(key);
    try { localStorage.setItem(WS_KEY, key); } catch { /* ignore */ }
    setSelectedRun(null);
    void api.putUiPrefs({ selectedWorkspace: key }).catch(() => {});
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
    void api.putUiPrefs({ selectedWorkspace: next.selectedWs }).catch(() => {});
    setSelectedRun(next.selectedRun);
    persistRead(next.selectedRun);
  }, [runs, hiddenRuns, persistRead]);

  const refresh = useCallback(() => {
    if (!authed) return;
    Promise.all([api.machines(), api.runs(), api.runs({ archived: true }), api.getCursorReload().catch(() => null)])
      .then(([m, r, hidden, reload]) => {
        setMachines(m);
        setRuns(Array.isArray(r) ? r : []);
        setHiddenRuns(Array.isArray(hidden) ? hidden : []);
        setCursorReload({
          needed: !!reload?.needed,
          neededMachineIds: Array.isArray(reload?.neededMachineIds) ? reload.neededMachineIds.filter((id): id is string => typeof id === "string") : [],
        });
        setLoadError("");
      })
      .catch((e) => {
        if (String(e).includes("unauthorized")) return;
        setLoadError("看板加载失败（hub 不可达）");
      });
  }, [authed]);

  useEffect(() => {
    const on401 = () => {
      if (decideAuthLoss(desktop) === "ask-host") {
        requestDesktop("need-token");
        return;
      }
      localStorage.removeItem("armada.token");
      setAuthed(false);
      setAuthDenied(true);
    };
    window.addEventListener("armada:unauthorized", on401);
    return () => window.removeEventListener("armada:unauthorized", on401);
  }, [desktop]);

  useEffect(() => {
    if (authed || !desktop) return;
    if (askedHost.current) return;
    askedHost.current = true;
    requestDesktop("need-token");
  }, [authed, desktop]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!authed) {
      setPrefsReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const local = loadLocalUiPrefsMirror();
      try {
        const remote = await api.getUiPrefs() as UiPrefsGetResponse;
        if (cancelled) return;
        const { source, ...prefs } = remote;
        applyUiPrefsToLocalStorage(prefs);
        setTheme(prefs.theme);
        setFontScale(loadFontScale());
        setSelectedWs(prefs.selectedWorkspace);
        setReadMap(prefs.readRuns);
        setReadRunsSeeded(prefs.readRunsSeeded);
        if (shouldMigrateLocal(source, local)) {
          try {
            const migrated = await api.putUiPrefs({
              theme: local.theme,
              fontScale: local.fontScale,
              selectedWorkspace: local.selectedWorkspace,
              readRuns: local.readRuns,
              readRunsSeeded: local.readRunsSeeded,
              detailWidth: local.detailWidth,
            }) as UiPrefs;
            if (cancelled) return;
            applyUiPrefsToLocalStorage(migrated);
            setTheme(migrated.theme);
            setFontScale(loadFontScale());
            setSelectedWs(migrated.selectedWorkspace);
            setReadMap(migrated.readRuns);
            setReadRunsSeeded(migrated.readRunsSeeded);
          } catch { /* keep hub defaults already applied */ }
        }
      } catch {
        // READ_FAIL / network: keep localStorage state; do not invent hub file
      } finally {
        if (!cancelled) setPrefsReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
    let t: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (e) => {
      if (!boardSseShouldRefresh(e.data)) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        refresh();
      }, BOARD_SSE_DEBOUNCE_MS);
    };
    return () => {
      if (t) clearTimeout(t);
      es.close();
    };
  }, [authed, refresh]);

  useEffect(() => {
    if (!shouldSeedReadRuns({ prefsReady, readRunsSeeded, runsLength: runs.length })) return;
    const seed: Record<string, number> = {};
    for (const r of runs) seed[r.id] = Date.now();
    try {
      localStorage.setItem(READ_KEY, JSON.stringify(seed));
      localStorage.setItem(READ_SEEDED, "1");
    } catch { /* ignore */ }
    setReadMap(seed);
    setReadRunsSeeded(true);
    void api.putUiPrefs({ readRuns: seed, readRunsSeeded: true }).catch(() => {});
  }, [runs, prefsReady, readRunsSeeded]);

  useEffect(() => {
    if (!resolvedWs || resolvedWs === selectedWs) return;
    try { localStorage.setItem(WS_KEY, resolvedWs); } catch { /* ignore */ }
    setSelectedWs(resolvedWs);
    if (prefsReady) void api.putUiPrefs({ selectedWorkspace: resolvedWs }).catch(() => {});
  }, [resolvedWs, selectedWs, prefsReady]);

  const selectedEnded = runs.find((r) => r.id === selectedRun)?.ended_at ?? null;
  useEffect(() => {
    if (!selectedRun) return;
    persistRead(selectedRun);
  }, [selectedRun, selectedEnded, persistRead]);

  const seenStatus = useRef<Map<string, string> | null>(null);
  const seenAsk = useRef<Map<string, string | null> | null>(null);
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
    if (runs.length === 0) return;
    if (!seenAsk.current) {
      seenAsk.current = seedAskStatus(runs);
      return;
    }
    const fresh = takeNewlyNeedInput(seenAsk.current, runs);
    if (fresh.length === 0) return;
    alertNeedInput(fresh, {
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
    applyFontScale(fontScale);
  }, [fontScale]);

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
    if (desktop) {
      return (
        <div className="h-screen flex items-center justify-center bg-background text-foreground">
          <div className="flex flex-col items-center gap-3">
            <p className={`${UI_TYPE} text-muted-foreground`}>正在重新连接中台…</p>
            <Button type="button" variant="outline" onClick={() => requestDesktop("leave-fleet")}>
              返回
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="h-screen flex items-center justify-center bg-background text-foreground">
        <form className="flex flex-col gap-3 w-80" onSubmit={(e) => {
          e.preventDefault();
          const v = new FormData(e.currentTarget).get("token");
          if (typeof v === "string" && v.trim()) { setToken(v.trim()); setAuthDenied(false); setAuthed(true); }
        }}>
          <h1 className="text-xl font-bold">Armada 舰队指挥台</h1>
          <p className={`${UI_META} text-muted-foreground leading-5`}>
            浏览器联调：先启动 hub，再粘贴 <code className="text-muted-foreground">~/.armada/token</code>。创建/加入舰队请用桌面应用。
          </p>
          {authDenied && <div className={`${UI_TYPE} text-destructive`}>令牌无效，请重新从 hub 机器复制（cat ~/.armada/token)</div>}
          <Input name="token" type="password" placeholder="配对令牌" />
          <Button type="submit">连接</Button>
        </form>
      </div>
    );
  }

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
    <div className="h-screen flex flex-col bg-background text-foreground">
      {loadError && (
        <div className={`px-4 py-2 ${UI_TYPE} text-destructive bg-destructive/10 border-b border-destructive/30`}>{loadError}</div>
      )}
      <header className="flex items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-border flex-wrap">
        <span className={`font-semibold ${UI_TYPE} tracking-wide shrink-0 whitespace-nowrap`}>Armada</span>
        <span className={`text-muted-foreground ${UI_META} shrink-0 whitespace-nowrap`}>{location.host}</span>
        <span className={`${UI_META} text-emerald-500/90 shrink-0 whitespace-nowrap`}>令牌已连接</span>
        <Button
          type="button"
          variant={showArchived ? "secondary" : "outline"}
          className="shrink-0"
          onClick={() => { setShowArchived((v) => !v); setSelectedRun(null); }}
        >
          {showArchived ? "返回看板" : `查看已隐藏${hiddenRuns.length ? ` ${hiddenRuns.length}` : ""}`}
        </Button>
        <span className="ml-auto flex items-center gap-2 flex-wrap shrink-0">
          <span className={`${UI_META} text-muted-foreground whitespace-nowrap`}>
            在线 {machines.filter((m) => m.status === "online").length}/{machines.length}
          </span>
          <Button type="button" variant="outline" className="shrink-0" onClick={() => { reloadSnippets(); setSettingsOpen(true); }}>
            设置
          </Button>
          <Button type="button" variant="outline" className="shrink-0" onClick={leaveFleet}>
            退出中台
          </Button>
        </span>
      </header>
      <div className="flex flex-1 min-h-0 relative">
        <Sidebar
          slots={slots}
          machines={machines}
          allRuns={runs}
          selectedKey={resolvedWs}
          onSelectWorkspace={selectWorkspace}
          readMap={readMap}
          onDispatch={() => { if (preset) { reloadSnippets(); setDispatchOpen(true); } }}
          onRename={(id, displayName) => { api.renameMachine(id, displayName).then(refresh); }}
          showDesktopActions={desktop}
          onOpenWorkspace={() => requestDesktop("open-workspace")}
          onRepairCdp={() => requestDesktop("repair-cdp")}
          onGetShareLink={() => requestDesktop("get-share-link")}
          onReloadMachine={(id, action) => { void api.postCursorReload(action, id).then(() => refresh()); }}
          reloadMachineIds={cursorReload.neededMachineIds}
        />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {showArchived && (
            <div className={`px-4 py-1.5 ${UI_META} text-amber-700 dark:text-amber-200 bg-amber-500/10 border-b border-amber-500/20`}>
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
            onRename={(id, prompt) => { api.renameRun(id, prompt).then(refresh); }}
            onRetry={(id) => { api.retry(id).then(refresh); }}
          />
        </div>
        {selectedRun && (
          <div className="absolute inset-0 z-40">
            <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" aria-label="关闭详情" onClick={() => setSelectedRun(null)} />
            <div className="absolute inset-y-0 right-0 flex pointer-events-none max-w-full">
              <div className="pointer-events-auto h-full min-h-0 max-w-full">
                <RunDetail
                  runId={selectedRun}
                  machines={machines}
                  onClose={() => setSelectedRun(null)}
                  onChanged={refresh}
                  snippets={snippets}
                  saveSnippets={saveSnippets}
                  reloadSnippets={reloadSnippets}
                />
              </div>
            </div>
          </div>
        )}
      </div>
      {dispatchOpen && preset && (
        <DispatchModal
          machines={machines}
          preset={preset}
          presetLabel={`${presetSlot?.machineName ?? preset.machineId} · ${workspaceFolderName(preset.workspaceRoot)}`}
          activeOnWorkspace={filterRunsByWorkspace(runs, preset.machineId, preset.workspaceRoot)
            .filter((r) => ["queued", "dispatched", "binding", "running"].includes(r.status)).length}
          snippets={snippets}
          saveSnippets={saveSnippets}
          reloadSnippets={reloadSnippets}
          onClose={() => setDispatchOpen(false)}
          onDone={() => { setDispatchOpen(false); refresh(); }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          theme={theme}
          fontScale={fontScale}
          snippets={snippets}
          saveSnippets={saveSnippets}
          reloadSnippets={reloadSnippets}
          snippetError={snippetError}
          onTheme={(next) => {
            saveTheme(next);
            applyTheme(next);
            setTheme(next);
            void api.putUiPrefs({ theme: next }).catch(() => {});
          }}
          onFontScale={(next) => {
            saveFontScale(next);
            applyFontScale(next);
            setFontScale(next);
            void api.putUiPrefs({ fontScale: next }).catch(() => {});
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
