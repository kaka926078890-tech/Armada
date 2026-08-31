import { useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { segmentChat, type ChatBlock } from "../chatView";

function ThoughtLive({ text }: { text: string }) {
  return <div className="text-[12px] text-zinc-500 whitespace-pre-wrap leading-relaxed">{text}</div>;
}

function modelLabel(model: string): string {
  return model.replace(/^cursor-/, "").replace(/-/g, " ");
}

function durationLabel(ms?: number): string {
  if (ms == null) return "";
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

function ProcessStep({ block }: { block: ChatBlock }) {
  if (block.kind === "thought") return <ThoughtLive text={block.text} />;
  if (block.kind === "tool") {
    return (
      <div className="flex items-center gap-2 text-[12px] text-zinc-400">
        <span className="size-1.5 rounded-full bg-zinc-600 shrink-0" />
        <span className="font-mono text-zinc-300">{block.summary}</span>
      </div>
    );
  }
  if (block.kind === "subagent") {
    const done = block.status === "completed";
    return (
      <div className="flex items-start gap-2 text-[12px]">
        <span className="text-sky-500 mt-0.5">▸</span>
        <div className="min-w-0">
          <div className="text-zinc-300">
            子代理{done ? " 已回复" : " 运行中"}
            {done && block.title ? <span className="text-zinc-500"> · {block.title}</span> : null}
          </div>
          <div className="text-zinc-600 mt-0.5">
            {block.model ? modelLabel(block.model) : ""}
            {block.durationMs != null ? ` · ${durationLabel(block.durationMs)}` : ""}
            {done ? " · Completed" : ""}
          </div>
        </div>
      </div>
    );
  }
  if (block.kind === "file") {
    return <div className="text-[12px] text-emerald-600/80">已编辑 {block.path.split(/[\\/]/).pop()}</div>;
  }
  return null;
}

function ProcessFold({ steps }: { steps: ChatBlock[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-left text-[12px] text-zinc-500 hover:text-zinc-300"
      >
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span> 思考过程
        <span className="text-zinc-600"> · {steps.length} 步</span>
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-2 pl-3 border-l border-zinc-800">
          {steps.map((s, i) => <ProcessStep key={`${s.kind}-${s.seq}-${i}`} block={s} />)}
        </div>
      ) : null}
    </div>
  );
}

const mdComponents = {
  h1: ({ children }: { children?: ReactNode }) => <h1 className="text-[16px] font-semibold text-zinc-100 mt-3 mb-1">{children}</h1>,
  h2: ({ children }: { children?: ReactNode }) => <h2 className="text-[15px] font-semibold text-zinc-100 mt-3 mb-1">{children}</h2>,
  h3: ({ children }: { children?: ReactNode }) => <h3 className="text-[14px] font-medium text-zinc-100 mt-3 mb-1">{children}</h3>,
  p: ({ children }: { children?: ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
  li: ({ children }: { children?: ReactNode }) => <li className="pl-0.5">{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => <strong className="font-medium text-zinc-100">{children}</strong>,
  em: ({ children }: { children?: ReactNode }) => <em className="italic">{children}</em>,
  hr: () => <hr className="border-zinc-800 my-3" />,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="border-l-2 border-zinc-700 pl-3 text-zinc-400 mb-2">{children}</blockquote>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} className="text-sky-400 hover:underline" target="_blank" rel="noreferrer">{children}</a>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="overflow-x-auto mb-2">
      <table className="text-[12px] border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => <th className="border border-zinc-700 px-2 py-1 text-left text-zinc-300">{children}</th>,
  td: ({ children }: { children?: ReactNode }) => <td className="border border-zinc-800 px-2 py-1 text-zinc-300">{children}</td>,
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="mb-2 p-2.5 rounded-md bg-zinc-900 overflow-x-auto text-[12px]">{children}</pre>
  ),
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    if (className) return <code className={className}>{children}</code>;
    return <code className="px-1 py-px rounded bg-zinc-800/80 text-zinc-200 text-[12px]">{children}</code>;
  },
};

export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="break-words leading-[1.65] text-[13px] text-zinc-200">
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</Markdown>
    </div>
  );
}

export default function ChatThread({ blocks }: { blocks: ChatBlock[] }) {
  if (blocks.length === 0) {
    return <div className="text-zinc-500 text-sm px-1 py-8 text-center">等待对话内容…</div>;
  }
  const segs = segmentChat(blocks);
  return (
    <div className="flex flex-col gap-4">
      {segs.map((s, i) => {
        const key = `${s.kind}-${s.seq}-${i}`;
        if (s.kind === "process") return <ProcessFold key={key} steps={s.steps} />;
        if (s.kind === "user") {
          return (
            <div key={key} className="flex justify-end">
              <div className="max-w-[88%] rounded-xl bg-zinc-800/70 px-3.5 py-2 text-[13px] text-zinc-100 leading-relaxed whitespace-pre-wrap">
                {s.text}
              </div>
            </div>
          );
        }
        if (s.kind === "assistant") {
          return <div key={key} className="px-0.5"><AssistantMarkdown text={s.text} /></div>;
        }
        return <ProcessStep key={key} block={s} />;
      })}
    </div>
  );
}
