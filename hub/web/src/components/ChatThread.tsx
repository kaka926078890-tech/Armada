import { useState } from "react";
import type { ChatBlock } from "../chatView";

function decorate(s: string) {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`")) {
      return <code key={i} className="px-1 py-px rounded bg-zinc-800/80 text-zinc-200 text-[12px]">{p.slice(1, -1)}</code>;
    }
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i} className="font-medium text-zinc-100">{p.slice(2, -2)}</strong>;
    }
    return <span key={i}>{p}</span>;
  });
}

function renderRichText(text: string) {
  const lines = text.split("\n");
  return (
    <div className="whitespace-pre-wrap break-words leading-[1.65] text-[13px] text-zinc-200">
      {lines.map((line, i) => {
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
          return <div key={i} className="font-medium text-zinc-100 mt-3 mb-1">{decorate(heading[2])}</div>;
        }
        if (line.startsWith("|") && line.endsWith("|")) {
          return <div key={i} className="font-mono text-[11px] text-zinc-400 overflow-x-auto">{line}</div>;
        }
        return <div key={i}>{line === "" ? "\u00a0" : decorate(line)}</div>;
      })}
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const first = text.split("\n").find((l) => l.trim()) ?? "思考";
  return (
    <button type="button" onClick={() => setOpen((v) => !v)}
      className="text-left w-full text-[12px] text-zinc-500 hover:text-zinc-400">
      <span className="inline-flex items-center gap-1">
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
        思考
      </span>
      {open ? (
        <div className="mt-1 pl-4 text-zinc-500 whitespace-pre-wrap leading-relaxed">{text}</div>
      ) : (
        <span className="ml-1 text-zinc-600">· {first.slice(0, 48)}{first.length > 48 ? "…" : ""}</span>
      )}
    </button>
  );
}

function modelLabel(model: string): string {
  return model.replace(/^cursor-/, "").replace(/-/g, " ");
}

function durationLabel(ms?: number): string {
  if (ms == null) return "";
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

export default function ChatThread({ blocks }: { blocks: ChatBlock[] }) {
  if (blocks.length === 0) {
    return <div className="text-zinc-500 text-sm px-1 py-8 text-center">等待对话内容…</div>;
  }
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((b, i) => {
        const key = `${b.kind}-${b.seq}-${i}`;
        if (b.kind === "user") {
          return (
            <div key={key} className="flex justify-end">
              <div className="max-w-[88%] rounded-xl bg-zinc-800/70 px-3.5 py-2 text-[13px] text-zinc-100 leading-relaxed">
                {b.text}
              </div>
            </div>
          );
        }
        if (b.kind === "assistant") {
          return <div key={key} className="px-0.5">{renderRichText(b.text)}</div>;
        }
        if (b.kind === "thought") {
          return <Thought key={key} text={b.text} />;
        }
        if (b.kind === "tool") {
          return (
            <div key={key} className="flex items-center gap-2 text-[12px] text-zinc-400 px-1">
              <span className="size-1.5 rounded-full bg-zinc-600 shrink-0" />
              <span className="font-mono text-zinc-300">{b.summary}</span>
            </div>
          );
        }
        if (b.kind === "subagent") {
          const done = b.status === "completed";
          return (
            <div key={key} className="flex items-start gap-2 px-1 text-[12px]">
              <span className="text-sky-500 mt-0.5">▸</span>
              <div className="min-w-0">
                <div className="text-zinc-300">
                  子代理{done ? " 已回复" : " 运行中"}
                  {done && b.title ? <span className="text-zinc-500"> · {b.title}</span> : null}
                </div>
                <div className="text-zinc-600 mt-0.5">
                  {b.model ? modelLabel(b.model) : ""}
                  {b.durationMs != null ? ` · ${durationLabel(b.durationMs)}` : ""}
                  {done ? " · Completed" : ""}
                </div>
              </div>
            </div>
          );
        }
        return (
          <div key={key} className="text-[12px] text-emerald-600/80 px-1">已编辑 {b.path.split(/[\\/]/).pop()}</div>
        );
      })}
    </div>
  );
}
