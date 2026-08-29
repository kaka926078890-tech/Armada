import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";
import type { Machine } from "./types";
import type { RunRow } from "./boardState";
import Sidebar from "./components/Sidebar";
import Board from "./components/Board";
import RunDetail from "./components/RunDetail";
import { DispatchModal } from "./components/Modals";

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [machines, setMachines] = useState<Machine[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [authDenied, setAuthDenied] = useState(false);

  const refresh = useCallback(() => {
    if (!authed) return;
    Promise.all([api.machines(), api.runs()])
      .then(([m, r]) => {
        setMachines(m);
        setRuns(r);
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

  useEffect(() => { // 全局 SSE:状态变化即时刷新看板
    if (!authed) return;
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
    es.onmessage = () => refresh();
    return () => es.close();
  }, [authed, refresh]);

  if (!authed) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
        <form className="flex flex-col gap-3 w-80" onSubmit={(e) => {
          e.preventDefault();
          const v = new FormData(e.currentTarget).get("token");
          if (typeof v === "string" && v.trim()) { setToken(v.trim()); setAuthDenied(false); setAuthed(true); }
        }}>
          <h1 className="text-xl font-bold">Armada 舰队指挥台</h1>
          {authDenied && <div className="text-sm text-red-400">令牌无效，请重新从 hub 机器复制（cat ~/.armada/token)</div>}
          <input name="token" type="password" placeholder="配对令牌" className="px-3 py-2 rounded bg-zinc-900 border border-zinc-700" />
          <button className="px-3 py-2 rounded bg-sky-600 hover:bg-sky-500">连接</button>
        </form>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {loadError && (
        <div className="px-4 py-2 text-sm text-red-400 bg-red-950/50 border-b border-red-900/50">{loadError}</div>
      )}
      <header className="flex items-center gap-4 px-4 py-2 border-b border-zinc-800">
        <span className="font-bold">Armada</span>
        <span className="text-zinc-400 text-sm">{location.host}</span>
        <span className="text-xs text-emerald-500">令牌已连接</span>
        <span className="ml-auto text-sm text-zinc-400">
          在线 {machines.filter((m) => m.status === "online").length}/{machines.length}
        </span>
      </header>
      <div className="flex flex-1 min-h-0">
        <Sidebar machines={machines} runs={runs} onDispatch={() => setDispatchOpen(true)} />
        <Board runs={runs} machines={machines} selected={selectedRun} onSelect={setSelectedRun} />
        {selectedRun && <RunDetail runId={selectedRun} onClose={() => setSelectedRun(null)} onChanged={refresh} />}
      </div>
      {dispatchOpen && (
        <DispatchModal machines={machines} onClose={() => setDispatchOpen(false)}
          onDone={() => { setDispatchOpen(false); refresh(); }} />
      )}
    </div>
  );
}
