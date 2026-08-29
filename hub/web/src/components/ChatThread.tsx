import type { ChatBlock } from "../chatView";

function renderRichText(text: string) {
  const lines = text.split("\n");
  return (
    <div className="whitespace-pre-wrap break-words leading-relaxed">
      {lines.map((line, i) => {
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
          return <div key={i} className="font-semibold text-zinc-100 mt-2 mb-1">{decorate(heading[2])}</div>;
        }
        if (line.startsWith("|") && line.endsWith("|")) {
          return <div key={i} className="font-mono text-[11px] text-zinc-300 overflow-x-auto">{line}</div>;
        }
        return <div key={i}>{line === "" ? "\u00a0" : decorate(line)}</div>;
      })}
    </div>
  );
}

function decorate(s: string) {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`")) {
      return <code key={i} className="px-1 rounded bg-zinc-800 text-sky-300 text-[11px]">{p.slice(1, -1)}</code>;
    }
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i} className="text-zinc-100 font-semibold">{p.slice(2, -2)}</strong>;
    }
    return <span key={i}>{p}</span>;
  });
}

export default function ChatThread({ blocks }: { blocks: ChatBlock[] }) {
  if (blocks.length === 0) {
    return <div className="text-zinc-500 text-sm px-1 py-4">等待对话内容…</div>;
  }
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((b, i) => {
        const key = `${b.kind}-${b.seq}-${i}`;
        if (b.kind === "user") {
          return (
            <div key={key} className="flex justify-end">
              <div className="max-w-[92%] rounded-2xl rounded-br-md bg-sky-900/70 px-3 py-2 text-sm text-zinc-100">
                {b.text}
              </div>
            </div>
          );
        }
        if (b.kind === "assistant") {
          return (
            <div key={key} className="flex justify-start">
              <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm text-zinc-200">
                {renderRichText(b.text)}
              </div>
            </div>
          );
        }
        if (b.kind === "thought") {
          return (
            <div key={key} className="text-xs text-zinc-500 italic px-1">思考：{b.text}</div>
          );
        }
        if (b.kind === "tool") {
          return (
            <div key={key} className="text-xs text-zinc-400 px-1 font-mono">⚙ {b.summary}</div>
          );
        }
        return (
          <div key={key} className="text-xs text-emerald-500/80 px-1">已编辑 {b.path.split(/[\\/]/).pop()}</div>
        );
      })}
    </div>
  );
}
