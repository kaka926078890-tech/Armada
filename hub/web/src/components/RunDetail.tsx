import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api, getToken } from "../api";
import type { RunEvent } from "../types";
import type { RunRow } from "../boardState";
import ChatThread from "./ChatThread";
import { eventsToChat } from "../chatView";
import { collectEventPages, mergeEvents, EVENT_PAGE_SIZE } from "../loadEvents";

const WIDTH_KEY = "armada.detailWidth.v1";
const DEFAULT_W = 576;
const MIN_W = 400;

function loadDetailWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n >= MIN_W) return n;
  } catch { /* ignore */ }
  return DEFAULT_W;
}

function persistDetailWidth(n: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(n)); } catch { /* ignore */ }
}

function clampWidth(n: number): number {
  const max = typeof window === "undefined" ? 960 : Math.max(MIN_W, Math.floor(window.innerWidth * 0.92));
  return Math.min(max, Math.max(MIN_W, Math.round(n)));
}

function DrawerShell({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(loadDetailWidth);
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, w: widthRef.current };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setWidth(clampWidth(d.w + (d.x - e.clientX)));
  };
  const onPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    persistDetailWidth(widthRef.current);
  };

  return (
    <aside className="h-full min-h-0 shrink-0 border-l border-zinc-800/80 flex flex-col bg-zinc-950 shadow-2xl relative" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整详情宽度"
        title="拖动调整宽度"
        className="absolute inset-y-0 left-0 w-2 z-10 cursor-ew-resize bg-zinc-700/25 hover:bg-sky-500/60 active:bg-sky-500/80"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {children}
    </aside>
  );
}

export default function RunDetail({ runId, onClose, onChanged }: {
  runId: string; onClose: () => void; onChanged: () => void;
}) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [followup, setFollowup] = useState("");
  const [followupError, setFollowupError] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [missing, setMissing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const jumpedRef = useRef<string | null>(null);

  useEffect(() => {
    jumpedRef.current = null;
    stickRef.current = true;
    let aborted = false;
    setRun(null);
    setEvents([]);
    setFollowupError("");
    setCancelError("");
    setLoadError("");
    setMissing(false);

    api.run(runId).then((r) => {
      if (aborted) return;
      if (r?.error) { setMissing(true); setRun(null); return; }
      setRun(r);
    }).catch(() => { if (!aborted) setLoadError("任务详情加载失败（hub 不可达）"); });

    const seqRef = { current: 0 };
    const reloadEvents = (afterSeq = 0) => {
      collectEventPages((after) => api.events(runId, after, EVENT_PAGE_SIZE) as Promise<RunEvent[]>, afterSeq, EVENT_PAGE_SIZE)
        .then((evs) => {
          if (aborted) return;
          setEvents((prev) => {
            const next = afterSeq === 0 ? evs : mergeEvents(prev, evs);
            seqRef.current = next.at(-1)?.seq ?? 0;
            return next;
          });
        })
        .catch(() => { if (!aborted) setLoadError("事件加载失败（hub 不可达）"); });
    };
    reloadEvents(0);

    const es = new EventSource(api.streamUrl(runId));
    es.onmessage = (e) => {
      if (aborted) return;
      let data: { type?: string };
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.type === "run.event") reloadEvents(seqRef.current);
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

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || events.length === 0) return;
    if (jumpedRef.current !== runId) {
      jumpedRef.current = runId;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events, runId]);

  const sendFollowup = useCallback((e?: FormEvent) => {
    e?.preventDefault();
    if (!run || !followup.trim()) return;
    setFollowupError("");
    api.followup(run.id, followup.trim()).then((r) => {
      if (r?.error) {
        setFollowupError(r.error === "WINDOW_BUSY"
          ? "同工作区已有任务在跑。新任务请点「+ 派发任务」开新对话，不要续聊这张旧卡。"
          : r.error);
        return;
      }
      setFollowup("");
      onChanged();
    }).catch((err) => setFollowupError(String(err)));
  }, [followup, onChanged, run]);

  if (missing) {
    return (
      <DrawerShell>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
          <span className="text-sm text-red-400">任务不存在或已删除</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
      </DrawerShell>
    );
  }

  if (loadError && !run) {
    return (
      <DrawerShell>
        <div className="px-3 py-2 text-sm text-red-400 bg-red-950/40 border-b border-red-900/50">{loadError}</div>
        <button onClick={onClose} className="m-3 text-zinc-500 hover:text-zinc-200 self-end">✕</button>
      </DrawerShell>
    );
  }

  if (!run) {
    return (
      <DrawerShell>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800/80">
          <span className="text-[13px] text-zinc-500">加载中…</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
      </DrawerShell>
    );
  }
  const active = ["dispatched", "binding", "running"].includes(run.status);
  const STATUS: Record<string, string> = {
    dispatched: "已派发", binding: "绑定中", running: "运行中",
    completed: "已完成", cancelled: "已取消", aborted: "已中止", error: "异常", unknown: "未知",
  };
  const chat = eventsToChat(events, run.prompt);
  return (
    <DrawerShell>
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
          {active && <button onClick={() => {
            setCancelError("");
            api.cancel(run.id).then((r) => {
              if (r?.error) { setCancelError(r.error); return; }
              onChanged();
            }).catch((err) => setCancelError(String(err)));
          }}
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
        {cancelError && <div className="mt-2 text-red-400 text-sm">{cancelError}</div>}
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
        }}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        <ChatThread blocks={chat} />
      </div>
      {run.conversation_id && (
        <form className="p-3 border-t border-zinc-800/80 flex flex-col gap-2" onSubmit={sendFollowup}>
          <div className="flex gap-2 items-end">
            <textarea
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendFollowup();
                }
              }}
              rows={3}
              placeholder="续聊同一对话…（Enter 发送，Shift+Enter 换行）"
              className="flex-1 min-h-[4.5rem] max-h-48 resize-y px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-[13px] placeholder:text-zinc-600 leading-relaxed"
            />
            <button type="submit" className="px-3 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 text-[13px] shrink-0">发送</button>
          </div>
          {followupError && <div className="text-red-400 text-sm">{followupError}</div>}
        </form>
      )}
    </DrawerShell>
  );
}
