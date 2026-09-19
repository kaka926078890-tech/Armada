import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { mergeAttachmentFiles, isConsoleAttachment, CONSOLE_ACCEPT } from "../attachments";
import { endFollowupSend, isFollowupSendEnter, tryBeginFollowupSend } from "../followupSend";
import { CDP_NOT_READY_COPY } from "../boardState";
import { appendSnippetBody } from "../promptSnippets";
import type { PromptSnippet } from "../uiPrefs";
import type { Machine } from "../types";
import { PromptSnippetBar } from "./PromptSnippetBar";
import { UI_BTN_GHOST, UI_BTN_PRIMARY, UI_META, UI_OVERLAY, UI_PANEL, UI_SELECT, UI_TEXTAREA, UI_TYPE } from "../ui";

const ERR: Record<string, string> = {
  RUN_LIMIT: "已达该机或该工作区并行上限",
  PROMPT_COLLISION: "相同提示词已在该工作区执行或排队",
  WINDOW_BUSY: "该窗口暂不支持并行（扩展需 ≥ 0.4.0 或已关闭同窗并行）",
  INJECT_SLOT_BUSY: "正在向该机注入另一条任务，请稍后再续聊",
  CONVERSATION_BUSY: "该对话仍在排队、绑定或等待回答选择题",
  WORKSPACE_NOT_OPEN: "工作区未打开",
  MACHINE_OFFLINE: "机器离线",
  CDP_NOT_READY: CDP_NOT_READY_COPY,
};

function parseWorkspaces(raw: string | undefined): { workspaces: string[]; parseFailed: boolean } {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return { workspaces: [], parseFailed: true };
    return {
      workspaces: parsed.filter((w): w is string => typeof w === "string"),
      parseFailed: false,
    };
  } catch {
    return { workspaces: [], parseFailed: true };
  }
}

export function DispatchModal({
  machines, preset, presetLabel, activeOnWorkspace, onClose, onDone,
  snippets = [], saveSnippets, reloadSnippets,
}: {
  machines: Machine[];
  preset?: { machineId: string; workspaceRoot: string };
  presetLabel?: string;
  activeOnWorkspace: number;
  onClose: () => void;
  onDone: () => void;
  snippets?: PromptSnippet[];
  saveSnippets?: (next: PromptSnippet[]) => Promise<void>;
  reloadSnippets?: () => void;
}) {
  const online = machines.filter((m) => m.status === "online");
  const [machineId, setMachineId] = useState(preset?.machineId ?? online[0]?.id ?? "");
  const [workspace, setWorkspace] = useState(preset?.workspaceRoot ?? "");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const sendingLock = useRef(false);
  useEffect(() => { reloadSnippets?.(); }, [reloadSnippets]);
  const raw = machineId ? online.find((m) => m.id === machineId)?.open_workspaces : undefined;
  const { workspaces, parseFailed } = machineId ? parseWorkspaces(raw) : { workspaces: [] as string[], parseFailed: false };
  const locked = !!preset;
  const selectedMachine = machineId ? online.find((m) => m.id === machineId) : undefined;
  const injectReady = selectedMachine?.cdp_ready === true;
  const canDispatch = !!machineId && !!workspace && (!!prompt.trim() || files.length > 0) && !sending && injectReady;

  const submitDispatch = () => {
    if (!machineId || !workspace || (!prompt.trim() && files.length === 0)) return;
    if (!injectReady) return;
    if (!tryBeginFollowupSend(sendingLock)) return;
    setSending(true);
    setError("");
    void (async () => {
      try {
        const ids: string[] = [];
        for (const f of files) {
          const r = await api.uploadBlob(f);
          if (r.error || !r.blob) { setError(r.error ?? "上传失败"); return; }
          ids.push(r.blob.id);
        }
        const r = await api.dispatch(machineId, workspace, prompt.trim(), ids);
        if (r.error) setError(ERR[r.error] ?? r.error); else onDone();
      } catch (err) { setError(String(err)); }
      finally {
        endFollowupSend(sendingLock);
        setSending(false);
      }
    })();
  };

  return (
    <div className={UI_OVERLAY} onClick={onClose}>
      <div className={`w-[32rem] ${UI_PANEL} p-4 flex flex-col gap-3`} onClick={(e) => e.stopPropagation()}>
        <h2 className={`font-bold ${UI_TYPE}`}>派发任务</h2>
        {locked ? (
          <div className={`${UI_TYPE} text-zinc-300 px-3 h-8 flex items-center rounded-lg bg-zinc-950 border border-zinc-800`}>
            当前工作区：{presetLabel ?? workspace}
          </div>
        ) : (
          <>
            <select value={machineId} onChange={(e) => { setMachineId(e.target.value); setWorkspace(""); }}
              className={UI_SELECT}>
              {online.map((m) => <option key={m.id} value={m.id}>{m.name}({m.os})</option>)}
            </select>
            <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}
              className={UI_SELECT}>
              <option value="">选择工作区…</option>
              {workspaces.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
            {parseFailed && <div className={`${UI_TYPE} text-red-400`}>工作区列表解析失败，无法选择</div>}
          </>
        )}
        {activeOnWorkspace > 0 && (
          <div className={`${UI_TYPE} text-amber-300/90`}>
            该工作区已有 {activeOnWorkspace} 个任务在跑或排队，并行可能争用同一批文件。
          </div>
        )}
        {selectedMachine && !injectReady && (
          <div className={`${UI_TYPE} text-red-400`}>{CDP_NOT_READY_COPY}</div>
        )}
        <PromptSnippetBar
          snippets={snippets}
          onAppend={(body) => setPrompt(appendSnippetBody(prompt, body))}
          onAdd={async (title, body) => {
            if (!saveSnippets) return;
            await saveSnippets([...snippets, { id: crypto.randomUUID(), title, body }]);
          }}
        />
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8}
          placeholder="提示词（Markdown 原文；Enter 派发，Shift+Enter 换行）"
          className={`w-full ${UI_TEXTAREA} font-mono min-h-[8rem] resize-y`}
          onKeyDown={(e) => {
            if (!isFollowupSendEnter(e)) return;
            e.preventDefault();
            e.nativeEvent.preventDefault();
            submitDispatch();
          }}
          onPaste={(e) => {
            const items = [...e.clipboardData.files];
            if (!items.length) return;
            const { files: next, rejected } = mergeAttachmentFiles(files, items);
            if (next.length === files.length && rejected === 0 && !items.some(isConsoleAttachment)) return;
            e.preventDefault();
            setFiles(next);
            if (rejected) setError("最多 4 个附件，已忽略多余文件");
          }} />
        <input type="file" accept={CONSOLE_ACCEPT} multiple onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          const { files: next, rejected } = mergeAttachmentFiles(files, picked);
          setFiles(next);
          if (rejected) setError("最多 4 个附件，已忽略多余文件");
          e.target.value = "";
        }} />
        {files.length > 0 && (
          <div className={`${UI_META} text-zinc-400 flex flex-col gap-1`}>
            {files.map((f, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span className="truncate">{f.name || "粘贴的图片"}</span>
                <button type="button" className="text-zinc-500" onClick={() => setFiles(files.filter((_, j) => j !== i))}>移除</button>
              </div>
            ))}
          </div>
        )}
        {error && <div className={`${UI_TYPE} text-red-400`}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={UI_BTN_GHOST}>取消</button>
          <button type="button" disabled={!canDispatch} onClick={() => submitDispatch()}
            className={UI_BTN_PRIMARY}>
            {sending ? "派发中…" : "派发"}
          </button>
        </div>
      </div>
    </div>
  );
}
