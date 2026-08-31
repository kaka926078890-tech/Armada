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
      if (data.type === "run.status" || data.type === "run.archived") {
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
      <aside className="w-[28rem] h-full shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950 shadow-2xl">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
          <span className="text-sm text-red-400">任务不存在或已删除</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
      </aside>
    );
  }

  if (loadError && !run) {
    return (
      <aside className="w-[28rem] h-full shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950 shadow-2xl">
        <div className="px-3 py-2 text-sm text-red-400 bg-red-950/40 border-b border-red-900/50">{loadError}</div>
        <button onClick={onClose} className="m-3 text-zinc-500 hover:text-zinc-200 self-end">✕</button>
      </aside>
    );
  }

  if (!run) {
    return (
      <aside className="w-[36rem] max-w-[42vw] h-full shrink-0 border-l border-zinc-800/80 flex flex-col bg-zinc-950 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800/80">
          <span className="text-[13px] text-zinc-500">加载中…</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
      </aside>
    );
  }
  const active = ["dispatched", "binding", "running"].includes(run.status);
  const STATUS: Record<string, string> = {
    dispatched: "已派发", binding: "绑定中", running: "运行中",
    completed: "已完成", cancelled: "已取消", aborted: "已中止", error: "异常", unknown: "未知",
  };
  const chat = eventsToChat(events, run.prompt);
  return (
    <aside className="w-[36rem] max-w-[42vw] h-full shrink-0 border-l border-zinc-800/80 flex flex-col bg-zinc-950 shadow-2xl">
      {loadError && (
        <div className="px-3 py-1.5 text-xs text-red-400 bg-red-950/40 border-b border-red-900/50">{loadError}</div>
      )}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800/80">
        <span className="font-medium text-[13px] truncate" title={run.prompt}>{run.prompt.length > 36 ? run.prompt.slice(0, 36) + "…" : run.prompt}</span>
        <span className={`text-xs ${active ? "text-sky-400" : "text-zinc-500"}`}>{STATUS[run.status] ?? run.status}</span>
        <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
      </div>
      <div className="px-4 py-2 text-[11px] text-zinc-500 border-b border-zinc-800/80">
        <div className="truncate" title={run.workspace_root}>{run.workspace_root.split("/").pop()}</div>
        <div className="mt-2 flex gap-2">
          {active && <button onClick={() => { if (confirm("确认取消该任务?")) api.cancel(run.id).then(onChanged); }}
            className="px-2 py-1 rounded-md bg-red-950/80 hover:bg-red-900 text-red-200">取消</button>}
          {["error", "unknown"].includes(run.status) && <button onClick={() => api.close(run.id).then(onChanged)}
            className="px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">人工关闭</button>}
          {run.archived_at
            ? <button onClick={() => { api.unarchive(run.id).then((res) => { if (res?.run) setRun(res.run); onChanged(); }); }} className="px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">取消隐藏</button>
            : ["dispatched", "binding", "running", "created"].includes(run.status) ? null
            : <button onClick={() => api.archive(run.id).then(() => { onChanged(); onClose(); })} className="px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">隐藏</button>}
          <a href={`/api/audit/export?token=${encodeURIComponent(getToken())}`}
            className="px-2 py-1 rounded-md bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300">导出审计</a>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <ChatThread blocks={chat} />
        <div ref={bottomRef} />
      </div>
      {run.conversation_id && (
        <form className="p-3 border-t border-zinc-800/80 flex flex-col gap-2" onSubmit={(e) => {
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
              placeholder="续聊同一对话…" className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-[13px] placeholder:text-zinc-600" />
            <button className="px-3 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 text-[13px]">发送</button>
          </div>
          {followupError && <div className="text-red-400 text-sm">{followupError}</div>}
        </form>
      )}
    </aside>
  );
}
