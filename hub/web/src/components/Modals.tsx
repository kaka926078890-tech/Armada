import { useState } from "react";
import { api } from "../api";
import type { Machine } from "../types";

export function DispatchModal({ machines, onClose, onDone }: {
  machines: Machine[]; onClose: () => void; onDone: () => void;
}) {
  const online = machines.filter((m) => m.status === "online");
  const [machineId, setMachineId] = useState(online[0]?.id ?? "");
  const [workspace, setWorkspace] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const workspaces = machineId ? JSON.parse(online.find((m) => m.id === machineId)?.open_workspaces ?? "[]") as string[] : [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="w-[32rem] rounded-lg bg-zinc-900 border border-zinc-700 p-4 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-bold">派发任务</h2>
        <select value={machineId} onChange={(e) => { setMachineId(e.target.value); setWorkspace(""); }}
          className="px-2 py-1.5 rounded bg-zinc-950 border border-zinc-700">
          {online.map((m) => <option key={m.id} value={m.id}>{m.name}({m.os})</option>)}
        </select>
        <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}
          className="px-2 py-1.5 rounded bg-zinc-950 border border-zinc-700">
          <option value="">选择工作区…</option>
          {workspaces.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6}
          placeholder="提示词…(派发后在被控机预填,需本机回车确认)" className="px-2 py-1.5 rounded bg-zinc-950 border border-zinc-700" />
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
