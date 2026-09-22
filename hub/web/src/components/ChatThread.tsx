import { useEffect, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { askOptionDisplayText, isFreeformAskOption, visibleAskOptions } from "../askOptions";
import { segmentChat, processFoldLabel, userMessageCaption, type ChatBlock } from "../chatView";
import { HubImageRow } from "./ImageThumb";
import { workspaceFilePathFromHref } from "../../../../extension/src/workspaceFile";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { UI_BODY, UI_META, UI_OPTION_OFF, UI_OPTION_ON, UI_TYPE } from "../ui";

function ThoughtLive({ text }: { text: string }) {
  return <div className="text-[12px] text-muted-foreground whitespace-pre-wrap leading-relaxed">{text}</div>;
}

function modelLabel(model: string): string {
  return model.replace(/^cursor-/, "").replace(/-/g, " ");
}

function durationLabel(ms?: number): string {
  if (ms == null) return "";
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

function ProcessStep({ block, onOpenFile }: { block: ChatBlock; onOpenFile?: (path: string) => void }) {
  if (block.kind === "thought") return <ThoughtLive text={block.text} />;
  if (block.kind === "tool") {
    const times = block.count && block.count > 1 ? ` × ${block.count}` : "";
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
        <span className="font-mono text-foreground">{block.summary}{times}</span>
      </div>
    );
  }
  if (block.kind === "subagent") {
    const done = block.status === "completed" || block.status === "error";
    return (
      <div className="flex items-start gap-2 text-[12px]">
        <span className="text-sky-500 mt-0.5">▸</span>
        <div className="min-w-0">
          <div className="text-foreground">
            子代理{done ? (block.status === "error" ? " 失败" : " 已回复") : " 运行中"}
            {block.title && block.title !== "子代理" ? <span className="text-muted-foreground"> · {block.title}</span> : null}
          </div>
          <div className="text-muted-foreground mt-0.5">
            {block.model ? modelLabel(block.model) : ""}
            {block.durationMs != null ? ` · ${durationLabel(block.durationMs)}` : ""}
            {done ? " · Completed" : ""}
          </div>
          {block.text ? (
            <div className="mt-1.5 text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
              <AssistantMarkdown text={block.text} onOpenFile={onOpenFile} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  if (block.kind === "file") {
    const name = block.path.split(/[\\/]/).pop() ?? block.path;
    if (!onOpenFile) return <div className="text-[12px] text-emerald-600/80">已编辑 {name}</div>;
    return (
      <button
        type="button"
        className="text-left text-[12px] text-emerald-600/80 hover:underline"
        onClick={() => onOpenFile(block.path)}
      >
        已编辑 {name}
      </button>
    );
  }
  return null;
}

function ProcessFold({ steps, onOpenFile }: { steps: ChatBlock[]; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-left text-[12px] text-muted-foreground hover:text-foreground"
      >
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span> {processFoldLabel(steps)}
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-2 pl-3 border-l border-border">
          {steps.map((s, i) => <ProcessStep key={`${s.kind}-${s.seq}-${i}`} block={s} onOpenFile={onOpenFile} />)}
        </div>
      ) : null}
    </div>
  );
}

function mdComponents(onOpenFile?: (path: string) => void) {
  return {
    h1: ({ children }: { children?: ReactNode }) => <h1 className="text-[16px] font-semibold text-foreground mt-3 mb-1">{children}</h1>,
    h2: ({ children }: { children?: ReactNode }) => <h2 className="text-[15px] font-semibold text-foreground mt-3 mb-1">{children}</h2>,
    h3: ({ children }: { children?: ReactNode }) => <h3 className="text-[14px] font-medium text-foreground mt-3 mb-1">{children}</h3>,
    p: ({ children }: { children?: ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
    ul: ({ children }: { children?: ReactNode }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
    ol: ({ children }: { children?: ReactNode }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
    li: ({ children }: { children?: ReactNode }) => <li className="pl-0.5">{children}</li>,
    strong: ({ children }: { children?: ReactNode }) => <strong className="font-medium text-foreground">{children}</strong>,
    em: ({ children }: { children?: ReactNode }) => <em className="italic">{children}</em>,
    hr: () => <hr className="border-border my-3" />,
    blockquote: ({ children }: { children?: ReactNode }) => (
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground mb-2">{children}</blockquote>
    ),
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const path = workspaceFilePathFromHref(href);
      if (path && onOpenFile) {
        return (
          <a
            href={href}
            className="text-primary hover:underline"
            onClick={(e) => {
              e.preventDefault();
              onOpenFile(path);
            }}
          >
            {children}
          </a>
        );
      }
      return <a href={href} className="text-primary hover:underline" target="_blank" rel="noreferrer">{children}</a>;
    },
    table: ({ children }: { children?: ReactNode }) => (
      <div className="overflow-x-auto mb-2">
        <table className="text-[12px] border-collapse">{children}</table>
      </div>
    ),
    th: ({ children }: { children?: ReactNode }) => <th className="border border-border px-2 py-1 text-left text-foreground">{children}</th>,
    td: ({ children }: { children?: ReactNode }) => <td className="border border-border px-2 py-1 text-foreground">{children}</td>,
    pre: ({ children }: { children?: ReactNode }) => (
      <pre className="mb-2 p-2.5 rounded-md bg-muted overflow-x-auto text-[12px]">{children}</pre>
    ),
    code: ({ className, children }: { className?: string; children?: ReactNode }) => {
      if (className) return <code className={className}>{children}</code>;
      return <code className="px-1 py-px rounded bg-muted text-foreground text-[12px]">{children}</code>;
    },
  };
}

export function AssistantMarkdown({ text, onOpenFile }: { text: string; onOpenFile?: (path: string) => void }) {
  return (
    <div className={`break-words leading-[1.65] ${UI_BODY} text-foreground`}>
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents(onOpenFile)}>{text}</Markdown>
    </div>
  );
}

function UserMarkdown({ text }: { text: string }) {
  return (
    <div className={`break-words leading-[1.65] ${UI_BODY} text-foreground`}>
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents()}>{text}</Markdown>
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
      className="mt-1.5 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export type AnswerAskBody = {
  request_id: string;
  action: "continue" | "skip" | "freeform";
  answers?: { question_id: string; option_ids: string[] }[];
  text?: string;
};

export function isPlanAsk(block: { askKind?: string }): boolean {
  return block.askKind === "plan";
}

export function continueAllowed(block: { continueAllowed?: boolean }): boolean {
  return block.continueAllowed !== false;
}

export function askContinueLabel(plan: boolean, busy: boolean): string {
  if (plan) return busy ? "Building..." : "Build";
  return busy ? "Continuing..." : "Continue";
}

export function askSkipLabel(busy: boolean): string {
  return busy ? "Skipping..." : "Skip";
}

export function askContinueAnswers(
  block: { askKind?: string; options: { id: string }[] },
  picked: string,
): { question_id: string; option_ids: string[] }[] {
  const id = isPlanAsk(block) ? (block.options[0]?.id || "build") : picked.trim();
  if (!id) return [];
  return [{ question_id: "q0", option_ids: [id] }];
}

/** Cursor's card body is plan.overview, stored on the Build option. Do not hide it. */
export function planOverviewOf(block: { askKind?: string; options: { text?: string }[] }): string {
  if (!isPlanAsk(block)) return "";
  const text = block.options[0]?.text?.trim() ?? "";
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
  const [picked, setPicked] = useState("");
  const [freeform, setFreeform] = useState("");
  const [busyAction, setBusyAction] = useState<"continue" | "skip" | "freeform" | null>(null);
  const pending = block.action === "pending" || block.action === "submit_failed" || block.action === "submitting";
  const wait = busyAction !== null || block.action === "submitting";
  const continueBusy = busyAction === "continue" || busyAction === "freeform" || (block.action === "submitting" && busyAction !== "skip");
  const skipBusy = busyAction === "skip";
  const interactive = pending && !!onAnswerAsk;
  const plan = isPlanAsk(block);
  const showContinue = continueAllowed(block);
  const overview = plan ? planOverviewOf(block) : "";
  const chips = visibleAskOptions(block.options);
  const typed = freeform.trim();
  const pickedFreeform = isFreeformAskOption(chips, picked);
  const canSubmit = plan || (pickedFreeform ? !!typed : !!picked);
  useEffect(() => {
    if (!busyAction) return;
    const t = window.setTimeout(() => setBusyAction(null), 8000);
    return () => window.clearTimeout(t);
  }, [busyAction]);
  const submit = async (action: "continue" | "skip" | "freeform") => {
    if (!onAnswerAsk || wait) return;
    setBusyAction(action);
    try {
      const ok = await onAnswerAsk({
        request_id: block.request_id,
        action,
        answers: action === "continue" ? askContinueAnswers(block, picked) : [],
        ...(action === "freeform" ? { text: typed } : {}),
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
      className={`rounded-xl border border-border bg-card/60 pl-3 pr-3 py-3 border-l-[3px] ${plan ? "border-l-[#F1B467]" : "border-l-[#599CE7]"}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={`${UI_META} uppercase tracking-wide text-muted-foreground mb-1`}>{plan ? "Created Plan" : "Questions"}</div>
      <div className={`${UI_TYPE} text-foreground leading-relaxed`}>
        <AssistantMarkdown text={block.prompt} />
      </div>
      {overview ? (
        <div className={`mt-2 max-h-80 overflow-y-auto ${UI_TYPE} text-muted-foreground leading-relaxed pr-1`}>
          <AssistantMarkdown text={overview} />
        </div>
      ) : null}
      {plan ? null : (
      <div className="mt-2.5 flex flex-col gap-2">
        {chips.map((o) => {
          const on = picked === o.id;
          const body = askOptionDisplayText(o.label, o.text);
          return (
            <div key={o.id} className="flex flex-col gap-2">
              <button
                type="button"
                disabled={!interactive || wait}
                aria-pressed={on}
                onClick={(e) => {
                  stopCard(e);
                  setPicked(o.id);
                  if (o.freeform !== true) setFreeform("");
                }}
                className={on ? UI_OPTION_ON : UI_OPTION_OFF}
              >
                <span className="text-muted-foreground font-mono mr-1.5">{o.label}</span>
                {body}
              </button>
              {on && o.freeform === true ? (
                <Textarea
                  placeholder="Other..."
                  value={freeform}
                  disabled={!interactive || wait}
                  rows={2}
                  className="min-h-8"
                  onChange={(e) => setFreeform(e.target.value)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      )}
      {block.action === "resolved" ? (
        <div className="mt-2 text-[12px] text-muted-foreground">已处理</div>
      ) : null}
      {block.action === "submit_failed" || block.error ? (
        <div className="mt-2 text-[12px] text-destructive">{block.error || "提交失败，请到本机点 Continue / Skip"}</div>
      ) : null}
      {interactive && (showContinue || !plan) ? (
        <div className="mt-3 pt-3 border-t border-border/80 flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
          {plan ? null : (
          <Button
            type="button"
            variant="secondary"
            disabled={wait}
            aria-busy={skipBusy}
            onClick={(e) => { stopCard(e); void submit("skip"); }}
          >
            {skipBusy ? <AskSpinner /> : null}
            {askSkipLabel(skipBusy)}
          </Button>
          )}
          {showContinue ? (
          <Button
            type="button"
            variant={plan ? "plan" : "default"}
            disabled={wait || (!plan && !canSubmit)}
            aria-busy={continueBusy}
            onClick={(e) => { stopCard(e); void submit(pickedFreeform ? "freeform" : "continue"); }}
          >
            {continueBusy ? <AskSpinner /> : null}
            {askContinueLabel(plan, continueBusy)}
          </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function ChatThread({ blocks, onAnswerAsk, onOpenFile }: {
  blocks: ChatBlock[];
  onAnswerAsk?: (body: AnswerAskBody) => Promise<boolean | void> | boolean | void;
  onOpenFile?: (path: string) => void;
}) {
  if (blocks.length === 0) {
    return <div className={`${UI_TYPE} text-muted-foreground px-1 py-8 text-center`}>等待对话内容…</div>;
  }
  const segs = segmentChat(blocks);
  return (
    <div className="flex flex-col gap-4">
      {segs.map((s, i) => {
        const key = `${s.kind}-${s.seq}-${i}`;
        if (s.kind === "process") return <ProcessFold key={key} steps={s.steps} onOpenFile={onOpenFile} />;
        if (s.kind === "user") {
          const caption = userMessageCaption(s.text, s.imageIds);
          return (
            <div key={key} className="flex justify-end">
              <div className="max-w-[78%] rounded-2xl bg-muted px-3.5 py-2 text-foreground leading-relaxed">
                {s.imageIds?.length ? (
                  <div className={caption ? "mb-2" : undefined}>
                    <HubImageRow ids={s.imageIds} />
                  </div>
                ) : null}
                {caption ? <UserMarkdown text={caption} /> : null}
              </div>
            </div>
          );
        }
        if (s.kind === "assistant") {
          return (
            <div key={key} className="px-0.5">
              <AssistantMarkdown text={s.text} onOpenFile={onOpenFile} />
              <CopyIconButton text={s.text} />
            </div>
          );
        }
        if (s.kind === "ask") {
          return <AskCard key={key} block={s} onAnswerAsk={onAnswerAsk} />;
        }
        return <ProcessStep key={key} block={s} onOpenFile={onOpenFile} />;
      })}
    </div>
  );
}
