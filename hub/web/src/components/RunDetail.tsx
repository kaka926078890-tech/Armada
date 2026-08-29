import { useEffect, useRef, useState } from "react";
import { api, getToken } from "../api";
import type { RunEvent } from "../types";
import type { RunRow } from "../boardState";

export default function RunDetail({ runId, onClose, onChanged }: {
  runId: string; onClose: () => void; onChanged: () => void;
}) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [followup, setFollowup] = useState("");
  const lastSeq = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEvents([]); lastSeq.current = 0;
    api.run(runId).then(setRun).catch(() => {});
    api.events(runId).then((evs: RunEvent[]) => {
      setEvents(evs);
      lastSeq.current = evs.at(-1)?.seq ?? 0;
    }).catch(() => {});
    const es = new EventSource(api.streamUrl(runId));
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "run.event") {
        api.events(runId, lastSeq.current).then((evs: RunEvent[]) => {
          if (evs.length) { setEvents((prev) => [...prev, ...evs]); lastSeq.current = evs.at(-1)!.seq; }
        });
      }
      if (data.type === "run.status") { api.run(runId).then(setRun); onChanged(); }
    };
    return () => es.close();
  }, [runId, onChanged]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [events.length]);

  if (!run) return null;
  const active = ["dispatched", "binding", "running"].includes(run.status);
  return (
    <aside className="w-[28rem] shrink-0 border-l border-zinc-800 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <span className="font-medium text-sm">{run.id}</span>
        <span className="text-xs text-zinc-400">{run.status}</span>
        <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
      </div>
      <div className="px-3 py-2 text-xs text-zinc-400 border-b border-zinc-800">
        <div>工作区:{run.workspace_root}</div>
        <div>conversation:{run.conversation_id ?? "—"}</div>
        <div>transcript:{run.transcript_path ?? "—"}</div>
        <div className="mt-2 flex gap-2">
          {active && <button onClick={() => { if (confirm("确认取消该任务?")) api.cancel(run.id).then(onChanged); }}
            className="px-2 py-1 rounded bg-red-900 hover:bg-red-800">取消</button>}
          {["error", "unknown"].includes(run.status) && <button onClick={() => api.close(run.id).then(onChanged)}
            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">人工关闭</button>}
          <a href={`/api/audit/export?token=${encodeURIComponent(getToken())}`}
            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">导出审计</a>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1 text-xs">
        {events.map((ev) => (
          <div key={ev.id} className={`px-2 py-1 rounded ${ev.source === "transcript" ? "bg-zinc-900" : "bg-zinc-900/40"}`}>
            <span className="text-zinc-500">[{ev.seq}]</span>{" "}
            <span className="text-sky-400">{ev.hook_event_name ?? ev.source}</span>{" "}
            <span className="text-zinc-400 break-all">{ev.payload.slice(0, 200)}</span>
            {ev.post_terminal === 1 && <span className="text-amber-500 ml-1">(终态后)</span>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {run.conversation_id && (
        <form className="p-3 border-t border-zinc-800 flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (followup.trim()) api.followup(run.id, followup.trim()).then(() => { setFollowup(""); onChanged(); });
        }}>
          <input value={followup} onChange={(e) => setFollowup(e.target.value)}
            placeholder="续聊(预填到同一对话,待本机回车)" className="flex-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-sm" />
          <button className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-sm">续聊</button>
        </form>
      )}
    </aside>
  );
}
