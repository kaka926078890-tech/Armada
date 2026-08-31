import { useState } from "react";
import { api } from "../api";
import type { Machine } from "../types";

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

export function DispatchModal({ machines, preset, presetLabel, onClose, onDone }: {
  machines: Machine[];
  preset?: { machineId: string; workspaceRoot: string };
  presetLabel?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const online = machines.filter((m) => m.status === "online");
  const [machineId, setMachineId] = useState(preset?.machineId ?? online[0]?.id ?? "");
  const [workspace, setWorkspace] = useState(preset?.workspaceRoot ?? "");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const raw = machineId ? online.find((m) => m.id === machineId)?.open_workspaces : undefined;
  const { workspaces, parseFailed } = machineId ? parseWorkspaces(raw) : { workspaces: [] as string[], parseFailed: false };
  const locked = !!preset;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="w-[32rem] rounded-lg bg-zinc-900 border border-zinc-700 p-4 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-bold">派发任务</h2>
        {locked ? (
          <div className="text-[13px] text-zinc-300 px-2 py-1.5 rounded bg-zinc-950 border border-zinc-800">
            当前工作区：{presetLabel ?? workspace}
          </div>
        ) : (
          <>
            <select value={machineId} onChange={(e) => { setMachineId(e.target.value); setWorkspace(""); }}
              className="px-2 py-1.5 rounded bg-zinc-950 border border-zinc-700">
              {online.map((m) => <option key={m.id} value={m.id}>{m.name}({m.os})</option>)}
            </select>
            <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}
              className="px-2 py-1.5 rounded bg-zinc-950 border border-zinc-700">
              <option value="">选择工作区…</option>
              {workspaces.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
            {parseFailed && <div className="text-red-400 text-sm">工作区列表解析失败，无法选择</div>}
          </>
        )}
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6}
          placeholder="提示词…" className="px-2 py-1.5 rounded bg-zinc-950 border border-zinc-700" />
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded bg-zinc-800">取消</button>
          <button disabled={!machineId || !workspace || !prompt.trim()} onClick={() => {
            api.dispatch(machineId, workspace, prompt.trim()).then((r) => {
              if (r.error) setError(r.error); else onDone();
            }).catch((e) => setError(String(e)));
          }} className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40">派发</button>
        </div>
      </div>
    </div>
  );
}
