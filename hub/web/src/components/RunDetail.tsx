import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api, getToken } from "../api";
import type { Machine, RunEvent } from "../types";
import { workspaceFolderName, runDisplayName, canRetryRun, CDP_NOT_READY_COPY, type RunRow } from "../boardState";
import ChatThread from "./ChatThread";
import { eventsToChat, mergePendingAsk, mergeOutboundChat, queuedOutbound, INITIAL_VISIBLE_TURNS, initialHiddenPrefixTurns, recentTurnsWindow } from "../chatView";
import { collectEventPages, mergeEvents, EVENT_PAGE_SIZE, hasOlderEvents, olderEventsQuery, shouldLoadOlder, prependPreserveScroll } from "../loadEvents";
import { mergeAttachmentFiles, isConsoleAttachment, CONSOLE_ACCEPT } from "../attachments";
import { endFollowupSend, isFollowupSendEnter, tryBeginFollowupSend } from "../followupSend";
import { WIDTH_KEY, type PromptSnippet } from "../uiPrefs";
import { appendSnippetBody } from "../promptSnippets";
import { PromptSnippetBar } from "./PromptSnippetBar";
import { UI_BTN, UI_BTN_GHOST, UI_BTN_PRIMARY, UI_INPUT, UI_META, UI_TEXTAREA, UI_TYPE } from "../ui";

const DEFAULT_W = 576;
const MIN_W = 400;
let widthPatchTimer: ReturnType<typeof setTimeout> | null = null;

function loadDetailWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n >= MIN_W) return n;
  } catch { /* ignore */ }
  return DEFAULT_W;
}

function persistDetailWidth(n: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(n)); } catch { /* ignore */ }
  if (widthPatchTimer) clearTimeout(widthPatchTimer);
  widthPatchTimer = setTimeout(() => {
    widthPatchTimer = null;
    void api.putUiPrefs({ detailWidth: n }).catch(() => {});
  }, 200);
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

export default function RunDetail({
  runId, onClose, onChanged, machines = [],
  snippets = [], saveSnippets, reloadSnippets,
}: {
  runId: string; onClose: () => void; onChanged: () => void; machines?: Machine[];
  snippets?: PromptSnippet[];
  saveSnippets?: (next: PromptSnippet[]) => Promise<void>;
  reloadSnippets?: () => void;
}) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [followup, setFollowup] = useState("");
  const [followupFiles, setFollowupFiles] = useState<File[]>([]);
  const [followupError, setFollowupError] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [retryError, setRetryError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [missing, setMissing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleError, setTitleError] = useState("");
  const [askError, setAskError] = useState("");
  const [hiddenPrefixTurns, setHiddenPrefixTurns] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const jumpedRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const sendEpoch = useRef(0);
  const seqRef = useRef(0);
  const tailReady = useRef(false);
  const windowInited = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const preserveRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const eventsRef = useRef<RunEvent[]>([]);
  const hiddenPrefixRef = useRef(0);

  useEffect(() => { reloadSnippets?.(); }, [runId, reloadSnippets]);

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
    setEditingTitle(false);
    setTitleError("");
    setHiddenPrefixTurns(0);
    setLoadingOlder(false);
    sendingRef.current = false;
    setSending(false);
    sendEpoch.current += 1;
    seqRef.current = 0;
    tailReady.current = false;
    windowInited.current = null;
    loadingOlderRef.current = false;
    preserveRef.current = null;
    eventsRef.current = [];
    hiddenPrefixRef.current = 0;

    api.run(runId).then((r) => {
      if (aborted) return;
      if (r?.error) { setMissing(true); setRun(null); return; }
      setRun(r);
    }).catch(() => { if (!aborted) setLoadError("任务详情加载失败（hub 不可达）"); });

    const applyEvents = (incoming: RunEvent[], mode: "replace" | "merge") => {
      if (mode === "replace") {
        seqRef.current = incoming.at(-1)?.seq ?? 0;
        eventsRef.current = incoming;
        setEvents(incoming);
        return;
      }
      setEvents((prev) => {
        const next = mergeEvents(prev, incoming);
        seqRef.current = next.at(-1)?.seq ?? 0;
        eventsRef.current = next;
        return next;
      });
    };

    const fetchForward = (afterSeq: number) => {
      collectEventPages(
        (after) => api.events(runId, { afterSeq: after, limit: EVENT_PAGE_SIZE }) as Promise<RunEvent[]>,
        afterSeq,
        EVENT_PAGE_SIZE,
      )
        .then((evs) => {
          if (aborted || !Array.isArray(evs) || evs.length === 0) return;
          applyEvents(evs, "merge");
        })
        .catch(() => { if (!aborted) setLoadError("事件加载失败（hub 不可达）"); });
    };

    api.events(runId, { fromEnd: true, limit: EVENT_PAGE_SIZE })
      .then((evs) => {
        if (aborted) return;
        const list = Array.isArray(evs) ? evs as RunEvent[] : [];
        applyEvents(list, "replace");
        if (windowInited.current !== runId) {
          const hidden = initialHiddenPrefixTurns(eventsToChat(list));
          windowInited.current = runId;
          hiddenPrefixRef.current = hidden;
          setHiddenPrefixTurns(hidden);
        }
        tailReady.current = true;
        if (seqRef.current > 0) fetchForward(seqRef.current);
      })
      .catch(() => { if (!aborted) setLoadError("事件加载失败（hub 不可达）"); });

    const es = new EventSource(api.streamUrl(runId));
    es.onmessage = (e) => {
      if (aborted) return;
      let data: { type?: string };
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.type === "run.event") {
        if (!tailReady.current) return;
        fetchForward(seqRef.current);
      }
      if (data.type === "run.status" || data.type === "run.archived" || data.type === "run.outbound") {
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

  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (el) preserveRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    if (hiddenPrefixRef.current > 0) {
      const next = Math.max(0, hiddenPrefixRef.current - INITIAL_VISIBLE_TURNS);
      hiddenPrefixRef.current = next;
      setHiddenPrefixTurns(next);
      return;
    }
    const q = olderEventsQuery(eventsRef.current);
    if (!q || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    void api.events(runId, { beforeSeq: q.beforeSeq, limit: EVENT_PAGE_SIZE })
      .then((evs) => {
        if (!Array.isArray(evs) || evs.length === 0) return;
        const next = mergeEvents(eventsRef.current, evs as RunEvent[]);
        eventsRef.current = next;
        seqRef.current = next.at(-1)?.seq ?? seqRef.current;
        setEvents(next);
      })
      .catch(() => setLoadError("事件加载失败（hub 不可达）"))
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [runId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (preserveRef.current) {
      el.scrollTop = prependPreserveScroll(preserveRef.current, el.scrollHeight);
      preserveRef.current = null;
      return;
    }
    if (events.length === 0) return;
    if (jumpedRef.current !== runId) {
      jumpedRef.current = runId;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events, runId, hiddenPrefixTurns]);

  const injectReady = run ? machines.find((m) => m.id === run.machine_id)?.cdp_ready === true : false;

  const sendFollowup = useCallback((e?: FormEvent) => {
    e?.preventDefault();
    if (!run || (!followup.trim() && followupFiles.length === 0)) return;
    if (!injectReady) {
      setFollowupError(CDP_NOT_READY_COPY);
      return;
    }
    if (!tryBeginFollowupSend(sendingRef)) return;
    setSending(true);
    setFollowupError("");
    const epoch = sendEpoch.current;
    void (async () => {
      try {
        const ids: string[] = [];
        if (run.status === "running" && followupFiles.length > 0) {
          setFollowupError("运行中续发暂只支持纯文本。");
          return;
        }
        for (const f of followupFiles) {
          const r = await api.uploadBlob(f);
          if (r.error || !r.blob) { setFollowupError(r.error ?? "上传失败"); return; }
          ids.push(r.blob.id);
        }
        const r = await api.followup(run.id, followup.trim(), ids);
        if (r?.error) {
          setFollowupError(r.error === "INJECT_SLOT_BUSY"
            ? "正在把另一条任务打进 Composer，几秒后再发即可；对方跑着不影响续聊。"
            : r.error === "CONVERSATION_BUSY"
              ? (run.pending_ask ? (run.pending_ask.kind === "plan" ? "请先点上方 Build。" : "请先回答上方选择题，续聊暂不可用。") : "该对话仍在排队或绑定，结束后才能续聊。")
              : r.error === "OUTBOUND_TEXT_ONLY"
                ? "运行中续发暂只支持纯文本。"
                : r.error === "OUTBOUND_LIMIT"
                  ? "待消化续发已达上限，等 Cursor 消化后再发。"
                  : r.error === "CDP_NOT_READY" ? CDP_NOT_READY_COPY
                  : r.error);
          return;
        }
        if (r?.run) setRun(r.run);
        setFollowup("");
        setFollowupFiles([]);
        onChanged();
      } catch (err) { setFollowupError(String(err)); }
      finally {
        if (sendEpoch.current === epoch) {
          endFollowupSend(sendingRef);
          setSending(false);
        }
      }
    })();
  }, [followup, followupFiles, injectReady, onChanged, run]);

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
    created: "已创建", queued: "排队中",
    dispatched: "已派发", binding: "绑定中", running: "运行中",
    completed: "已完成", cancelled: "已取消", aborted: "已中止", error: "异常", unknown: "未知",
  };
  const chatAll = mergePendingAsk(mergeOutboundChat(eventsToChat(events), run.outbound), run.pending_ask);
  const queued = queuedOutbound(run.outbound);
  const chat = recentTurnsWindow(chatAll, hiddenPrefixTurns);
  const hasOlder = hiddenPrefixTurns > 0 || hasOlderEvents(events);
  const titleText = runDisplayName(run) || "图片";
  const commitTitle = () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === runDisplayName(run)) return;
    setTitleError("");
    api.renameRun(run.id, next).then((r) => {
      if (r?.error) { setTitleError(r.error); return; }
      if (r?.run) setRun(r.run);
      onChanged();
    }).catch((err) => setTitleError(String(err)));
  };
  return (
    <DrawerShell>
      {loadError && (
        <div className="px-3 py-1.5 text-xs text-red-400 bg-red-950/40 border-b border-red-900/50">{loadError}</div>
      )}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800/80">
        {editingTitle ? (
          <input
            autoFocus
            className={`min-w-0 flex-1 ${UI_INPUT}`}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
              if (e.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <button
            type="button"
            className={`font-medium ${UI_TYPE} truncate text-left min-w-0 flex-1 hover:text-sky-300`}
            title={`${titleText}（点击修改标题）`}
            onClick={() => { setTitleDraft(runDisplayName(run)); setEditingTitle(true); }}
          >
            {titleText.length > 36 ? `${titleText.slice(0, 36)}…` : titleText}
          </button>
        )}
        <span className={`text-xs shrink-0 ${active ? "text-sky-400" : "text-zinc-500"}`}>{STATUS[run.status] ?? run.status}</span>
        <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
      </div>
      <div className={`px-4 py-2 ${UI_META} text-zinc-500 border-b border-zinc-800/80`}>
        <div className="truncate" title={run.workspace_root}>{workspaceFolderName(run.workspace_root)}</div>
        {titleError && <div className="mt-1 text-red-400">{titleError}</div>}
        {!injectReady && <div className="mt-1 text-red-400">{CDP_NOT_READY_COPY}</div>}
        <div className="mt-2 flex gap-2">
          {active && <button onClick={() => {
            setCancelError("");
            api.cancel(run.id).then((r) => {
              if (r?.error) { setCancelError(r.error); return; }
              onChanged();
            }).catch((err) => setCancelError(String(err)));
          }}
            className={`${UI_BTN} bg-red-950/80 hover:bg-red-900 text-red-200`}>取消</button>}
          {["error", "unknown"].includes(run.status) && <button onClick={() => api.close(run.id).then(onChanged)}
            className={UI_BTN_GHOST}>人工关闭</button>}
          {canRetryRun(run) && <button disabled={!injectReady} onClick={() => {
            setRetryError("");
            api.retry(run.id).then((r) => {
              if (r?.error) {
                setRetryError(r.error === "INJECT_SLOT_BUSY"
                  ? "正在把另一条任务打进 Composer，几秒后再试。"
                  : r.error === "CDP_NOT_READY" ? CDP_NOT_READY_COPY
                  : r.error === "WORKSPACE_NOT_OPEN" ? "工作区没有打开。"
                  : r.error === "MACHINE_OFFLINE" ? "机器离线。"
                  : r.error === "PROMPT_COLLISION" ? "同一工作区已有相同内容的任务。"
                  : r.error === "RUN_LIMIT" ? "这台机器任务数已满。"
                  : r.error === "WINDOW_BUSY" ? "该窗口正忙。"
                  : r.error);
                return;
              }
              if (r?.run) setRun(r.run);
              onChanged();
            }).catch((err) => setRetryError(String(err)));
          }}
            className={`${UI_BTN} bg-sky-800 hover:bg-sky-700 text-sky-100`}>重试</button>}
          {run.archived_at
            ? <button onClick={() => { api.unarchive(run.id).then((res) => { if (res?.run) setRun(res.run); onChanged(); }); }} className={UI_BTN_GHOST}>取消隐藏</button>
            : ["dispatched", "binding", "running", "created"].includes(run.status) ? null
            : <button onClick={() => api.archive(run.id).then(() => { onChanged(); onClose(); })} className={UI_BTN_GHOST}>隐藏</button>}
          <a href={`/api/audit/export?token=${encodeURIComponent(getToken())}`}
            className={`${UI_BTN_GHOST} text-zinc-300`}>导出审计</a>
        </div>
        {cancelError && <div className="mt-2 text-red-400 text-sm">{cancelError}</div>}
        {retryError && <div className="mt-2 text-red-400 text-sm">{retryError}</div>}
        {askError && <div className="mt-2 text-red-400 text-sm">{askError}</div>}
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
          if (shouldLoadOlder({
            scrollTop: el.scrollTop,
            hasOlder: hiddenPrefixRef.current > 0 || hasOlderEvents(eventsRef.current),
            loading: loadingOlderRef.current,
          })) loadOlder();
        }}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {hasOlder && (
          <button
            type="button"
            disabled={loadingOlder}
            onClick={loadOlder}
            className={`w-full mb-3 h-8 ${UI_META} text-zinc-500 hover:text-zinc-300 disabled:opacity-40`}
          >
            {loadingOlder ? "加载更早对话…" : "加载更早对话"}
          </button>
        )}
        <ChatThread
          blocks={chat}
          onAnswerAsk={run.pending_ask ? async (body) => {
            setAskError("");
            const r = await api.answerAsk(run.id, body);
            if (r?.error) {
              setAskError(r.error === "ASK_IN_FLIGHT" ? "正在提交，请稍候"
                : r.error === "ASK_INVALID_OPTION" ? "选项无效，请改选或 Skip"
                : "提交失败，请到本机点 Continue / Skip");
              return false;
            }
            if (r?.run) setRun(r.run);
            onChanged();
            return true;
          } : undefined}
        />
        {queued.length > 0 && (
          <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2" aria-label="Queued messages">
            <div className={`${UI_META} text-zinc-500 mb-1`}>
              {queued.length} Queued Message{queued.length > 1 ? "s" : ""}
            </div>
            <div className="flex flex-col gap-1.5">
              {queued.map((q) => (
                <div key={q.id} className="text-[13px] text-zinc-200 leading-relaxed">{q.prompt}</div>
              ))}
            </div>
          </div>
        )}
      </div>
      {run.conversation_id && (
        <div className="p-3 border-t border-zinc-800/80 flex flex-col gap-2">
          <PromptSnippetBar
            snippets={snippets}
            onAppend={(body) => setFollowup(appendSnippetBody(followup, body))}
            onAdd={async (title, body) => {
              if (!saveSnippets) return;
              await saveSnippets([...snippets, { id: crypto.randomUUID(), title, body }]);
            }}
          />
          <form className="flex flex-col gap-2" onSubmit={sendFollowup}>
          <div className="flex gap-2 items-end">
            <textarea
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
              onPaste={(e) => {
                const items = [...e.clipboardData.files];
                if (!items.length) return;
                const { files: next, rejected } = mergeAttachmentFiles(followupFiles, items);
                if (next.length === followupFiles.length && rejected === 0 && !items.some(isConsoleAttachment)) return;
                e.preventDefault();
                setFollowupFiles(next);
                if (rejected) setFollowupError("最多 4 个附件，已忽略多余文件");
              }}
              onKeyDown={(e) => {
                if (!isFollowupSendEnter(e)) return;
                e.preventDefault();
                sendFollowup();
              }}
              rows={3}
              placeholder={run.pending_ask ? (run.pending_ask.kind === "plan" ? "请先点上方 Build…" : "请先回答上方选择题…") : run.status === "running" ? "Add a follow-up…" : "续聊同一对话…（Enter 发送，Shift+Enter 换行；可粘贴截图）"}
              className={`flex-1 min-h-[4.5rem] max-h-48 resize-y ${UI_TEXTAREA} bg-zinc-900 placeholder:text-zinc-600`}
            />
            <button type="submit" disabled={!injectReady || sending || (!followup.trim() && followupFiles.length === 0)} className={`${UI_BTN_PRIMARY} shrink-0`}>发送</button>
          </div>
          <input type="file" accept={CONSOLE_ACCEPT} multiple onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            const { files: next, rejected } = mergeAttachmentFiles(followupFiles, picked);
            setFollowupFiles(next);
            if (rejected) setFollowupError("最多 4 个附件，已忽略多余文件");
            e.target.value = "";
          }} />
          {followupFiles.length > 0 && (
            <div className="text-[12px] text-zinc-400 flex flex-col gap-1">
              {followupFiles.map((f, i) => (
                <div key={i} className="flex justify-between gap-2">
                  <span className="truncate">{f.name || "粘贴的图片"}</span>
                  <button type="button" className="text-zinc-500" onClick={() => setFollowupFiles(followupFiles.filter((_, j) => j !== i))}>移除</button>
                </div>
              ))}
            </div>
          )}
        </form>
        </div>
      )}
    </DrawerShell>
  );
}
