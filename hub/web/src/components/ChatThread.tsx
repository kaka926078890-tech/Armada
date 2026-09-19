import { useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { segmentChat, processFoldLabel, type ChatBlock } from "../chatView";
import { ASK_CONTINUE_BTN, ASK_PLAN_BTN, ASK_SKIP_BTN, UI_BODY, UI_META, UI_OPTION_OFF, UI_OPTION_ON, UI_TYPE } from "../ui";

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
    const times = block.count && block.count > 1 ? ` × ${block.count}` : "";
    return (
      <div className="flex items-center gap-2 text-[12px] text-zinc-400">
        <span className="size-1.5 rounded-full bg-zinc-600 shrink-0" />
        <span className="font-mono text-zinc-300">{block.summary}{times}</span>
      </div>
    );
  }
  if (block.kind === "subagent") {
    const done = block.status === "completed" || block.status === "error";
    return (
      <div className="flex items-start gap-2 text-[12px]">
        <span className="text-sky-500 mt-0.5">▸</span>
        <div className="min-w-0">
          <div className="text-zinc-300">
            子代理{done ? (block.status === "error" ? " 失败" : " 已回复") : " 运行中"}
            {block.title && block.title !== "子代理" ? <span className="text-zinc-500"> · {block.title}</span> : null}
          </div>
          <div className="text-zinc-600 mt-0.5">
            {block.model ? modelLabel(block.model) : ""}
            {block.durationMs != null ? ` · ${durationLabel(block.durationMs)}` : ""}
            {done ? " · Completed" : ""}
          </div>
          {block.text ? (
            <div className="mt-1.5 text-zinc-400 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
              <AssistantMarkdown text={block.text} />
            </div>
          ) : null}
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
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span> {processFoldLabel(steps)}
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
    <div className={`break-words leading-[1.65] ${UI_BODY} text-zinc-200`}>
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents}>{text}</Markdown>
    </div>
  );
}

function UserMarkdown({ text }: { text: string }) {
  return (
    <div className={`break-words leading-[1.65] ${UI_BODY} text-zinc-100`}>
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents}>{text}</Markdown>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <rect x="5.5" y="1.5" width="9" height="9" rx="1.5" />
      <path d="M10.5 5.5H2.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3.5 8.5l3 3 6-6.5" />
    </svg>
  );
}

function copyText(text: string): void {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
  };
  if (!navigator.clipboard?.writeText) { fallback(); return; }
  void navigator.clipboard.writeText(text).catch(fallback);
}

function CopyIconButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "已复制" : "复制正文"}
      title={copied ? "已复制" : "复制正文"}
      onClick={() => {
        copyText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
      className="mt-1.5 p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export type AnswerAskBody = {
  request_id: string;
  action: "continue" | "skip";
  answers?: { question_id: string; option_ids: string[] }[];
};

export { ASK_CONTINUE_BTN, ASK_PLAN_BTN, ASK_SKIP_BTN };

export function isPlanAskOptions(options: { id: string }[]): boolean {
  return options.length === 1 && options[0]?.id === "build";
}

export function askContinueLabel(plan: boolean, busy: boolean): string {
  if (plan) return busy ? "Building..." : "Build";
  return busy ? "Continuing..." : "Continue";
}

export function askSkipLabel(busy: boolean): string {
  return busy ? "Skipping..." : "Skip";
}

/** Cursor's card body is plan.overview, stored on the Build option. Do not hide it. */
export function planOverviewOf(options: { id: string; text?: string }[]): string {
  if (!isPlanAskOptions(options)) return "";
  const text = options[0]?.text?.trim() ?? "";
  if (!text || text === "Build") return "";
  return text;
}

function AskSpinner() {
  return (
    <svg className="size-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function AskCard({ block, onAnswerAsk }: {
  block: Extract<ChatBlock, { kind: "ask" }>;
  onAnswerAsk?: (body: AnswerAskBody) => Promise<boolean | void> | boolean | void;
}) {
  const [picked, setPicked] = useState(block.options[0]?.id ?? "");
  const [busyAction, setBusyAction] = useState<"continue" | "skip" | null>(null);
  const pending = block.action === "pending" || block.action === "submit_failed" || block.action === "submitting";
  const wait = busyAction !== null || block.action === "submitting";
  const continueBusy = busyAction === "continue" || (block.action === "submitting" && busyAction !== "skip");
  const skipBusy = busyAction === "skip";
  const interactive = pending && !!onAnswerAsk;
  const plan = isPlanAskOptions(block.options);
  const overview = plan ? planOverviewOf(block.options) : "";
  const submit = async (action: "continue" | "skip") => {
    if (!onAnswerAsk || wait) return;
    setBusyAction(action);
    try {
      const ok = await onAnswerAsk({
        request_id: block.request_id,
        action,
        answers: action === "continue" ? [{ question_id: "q0", option_ids: [picked] }] : [],
      });
      if (ok === false) setBusyAction(null);
    } catch {
      setBusyAction(null);
    }
  };
  const stopCard = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.stopPropagation();
    e.preventDefault();
  };
  return (
    <div
      className={`rounded-xl border border-zinc-800 bg-zinc-900/60 pl-3 pr-3 py-3 border-l-[3px] ${plan ? "border-l-[#F1B467]" : "border-l-[#599CE7]"}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={`${UI_META} uppercase tracking-wide text-zinc-500 mb-1`}>{plan ? "Created Plan" : "Questions"}</div>
      <div className={`${UI_TYPE} text-zinc-200 leading-relaxed`}>
        <AssistantMarkdown text={block.prompt} />
      </div>
      {overview ? (
        <div className={`mt-2 max-h-80 overflow-y-auto ${UI_TYPE} text-zinc-400 leading-relaxed pr-1`}>
          <AssistantMarkdown text={overview} />
        </div>
      ) : null}
      {plan ? null : (
      <div className="mt-2.5 flex flex-col gap-2">
        {block.options.map((o) => {
          const on = picked === o.id;
          return (
            <button
              key={o.id}
              type="button"
              disabled={!interactive || wait}
              aria-pressed={on}
              onClick={(e) => { stopCard(e); setPicked(o.id); }}
              className={on ? UI_OPTION_ON : UI_OPTION_OFF}
            >
              <span className="text-zinc-500 font-mono mr-1.5">{o.label}</span>
              {o.text}
            </button>
          );
        })}
      </div>
      )}
      {block.action === "resolved" ? (
        <div className="mt-2 text-[12px] text-zinc-500">已处理</div>
      ) : null}
      {block.action === "submit_failed" || block.error ? (
        <div className="mt-2 text-[12px] text-red-400">{block.error || "提交失败，请到本机点 Continue / Skip"}</div>
      ) : null}
      {interactive ? (
        <div className="mt-3 pt-3 border-t border-zinc-800/80 flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
          {plan ? null : (
          <button
            type="button"
            disabled={wait}
            aria-busy={skipBusy}
            onClick={(e) => { stopCard(e); void submit("skip"); }}
            className={ASK_SKIP_BTN}
          >
            {skipBusy ? <AskSpinner /> : null}
            {askSkipLabel(skipBusy)}
          </button>
          )}
          <button
            type="button"
            disabled={wait || (!plan && !picked)}
            aria-busy={continueBusy}
            onClick={(e) => { stopCard(e); void submit("continue"); }}
            className={plan ? ASK_PLAN_BTN : ASK_CONTINUE_BTN}
          >
            {continueBusy ? <AskSpinner /> : null}
            {askContinueLabel(plan, continueBusy)}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function ChatThread({ blocks, onAnswerAsk }: {
  blocks: ChatBlock[];
  onAnswerAsk?: (body: AnswerAskBody) => Promise<boolean | void> | boolean | void;
}) {
  if (blocks.length === 0) {
    return <div className={`${UI_TYPE} text-zinc-500 px-1 py-8 text-center`}>等待对话内容…</div>;
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
              <div className="max-w-[78%] rounded-2xl bg-zinc-800/70 px-3.5 py-2 text-zinc-100 leading-relaxed">
                <UserMarkdown text={s.text} />
              </div>
            </div>
          );
        }
        if (s.kind === "assistant") {
          return (
            <div key={key} className="px-0.5">
              <AssistantMarkdown text={s.text} />
              <CopyIconButton text={s.text} />
            </div>
          );
        }
        if (s.kind === "ask") {
          return <AskCard key={key} block={s} onAnswerAsk={onAnswerAsk} />;
        }
        return <ProcessStep key={key} block={s} />;
      })}
    </div>
  );
}
