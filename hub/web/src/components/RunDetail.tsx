import { useEffect, useRef, useState } from "react";
import { api, getToken } from "../api";
import type { RunEvent } from "../types";
import type { RunRow } from "../boardState";
import ChatThread from "./ChatThread";
import { eventsToChat } from "../chatView";

export default function RunDetail({ runId, onClose, onChanged }: {
  runId: string; onClose: () => void; onChanged: () => void;
}) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [followup, setFollowup] = useState("");
  const [followupError, setFollowupError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [missing, setMissing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let aborted = false;
    setRun(null);
    setEvents([]);
    setFollowupError("");
    setLoadError("");
    setMissing(false);

    api.run(runId).then((r) => {
      if (aborted) return;
      if (r?.error) { setMissing(true); setRun(null); return; }
      setRun(r);
    }).catch(() => { if (!aborted) setLoadError("任务详情加载失败（hub 不可达）"); });

    const reloadEvents = () => {
      api.events(runId).then((evs: RunEvent[]) => {
        if (aborted) return;
        if (Array.isArray(evs)) setEvents(evs);
      }).catch(() => { if (!aborted) setLoadError("事件加载失败（hub 不可达）"); });
    };
    reloadEvents();

    const es = new EventSource(api.streamUrl(runId));
    es.onmessage = (e) => {
      if (aborted) return;
      let data: { type?: string };
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.type === "run.event") reloadEvents();
      if (data.type === "run.status") {
        api.run(runId).then((r) => {
          if (aborted) return;
          if (r?.error) { setMissing(true); setRun(null); return; }
          setRun(r);
        });
        onChanged();
      }
    };
    return () => { aborted = true; es.close(); };
  }, [runId, onChanged]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [events.length]);

  if (missing) {
    return (
      <aside className="w-[28rem] shrink-0 border-l border-zinc-800 flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
          <span className="text-sm text-red-400">任务不存在或已删除</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
      </aside>
    );
  }

  if (loadError && !run) {
    return (
      <aside className="w-[28rem] shrink-0 border-l border-zinc-800 flex flex-col">
        <div className="px-3 py-2 text-sm text-red-400 bg-red-950/40 border-b border-red-900/50">{loadError}</div>
        <button onClick={onClose} className="m-3 text-zinc-500 hover:text-zinc-200 self-end">✕</button>
      </aside>
    );
  }

  if (!run) return null;
  const active = ["dispatched", "binding", "running"].includes(run.status);
  const STATUS: Record<string, string> = {
    dispatched: "已派发", binding: "待提交", running: "运行中",
    completed: "已完成", cancelled: "已取消", aborted: "已中止", error: "异常", unknown: "未知",
  };
  const chat = eventsToChat(events);
  return (
    <aside className="w-[32rem] shrink-0 border-l border-zinc-800 flex flex-col">
      {loadError && (
        <div className="px-3 py-1.5 text-xs text-red-400 bg-red-950/40 border-b border-red-900/50">{loadError}</div>
      )}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <span className="font-medium text-sm truncate" title={run.prompt}>{run.prompt.length > 28 ? run.prompt.slice(0, 28) + "…" : run.prompt}</span>
        <span className={`text-xs ${active ? "text-sky-400" : "text-zinc-400"}`}>{STATUS[run.status] ?? run.status}</span>
        <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
      </div>
      <div className="px-3 py-2 text-xs text-zinc-400 border-b border-zinc-800">
        <div className="truncate" title={run.workspace_root}>{run.workspace_root.split("/").pop()}</div>
        <div className="mt-2 flex gap-2">
          {active && <button onClick={() => { if (confirm("确认取消该任务?")) api.cancel(run.id).then(onChanged); }}
            className="px-2 py-1 rounded bg-red-900 hover:bg-red-800">取消</button>}
          {["error", "unknown"].includes(run.status) && <button onClick={() => api.close(run.id).then(onChanged)}
            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">人工关闭</button>}
          <a href={`/api/audit/export?token=${encodeURIComponent(getToken())}`}
            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">导出审计</a>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <ChatThread blocks={chat} />
        <div ref={bottomRef} />
      </div>
      {run.conversation_id && (
        <form className="p-3 border-t border-zinc-800 flex flex-col gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (!followup.trim()) return;
          setFollowupError("");
          api.followup(run.id, followup.trim()).then((r) => {
            if (r?.error) { setFollowupError(r.error); return; }
            setFollowup("");
            onChanged();
          }).catch((err) => setFollowupError(String(err)));
        }}>
          <div className="flex gap-2">
            <input value={followup} onChange={(e) => setFollowup(e.target.value)}
              placeholder="续聊(发到同一对话,卡片会回到运行中)" className="flex-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-sm" />
            <button className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-sm">续聊</button>
          </div>
          {followupError && <div className="text-red-400 text-sm">{followupError}</div>}
        </form>
      )}
    </aside>
  );
}
