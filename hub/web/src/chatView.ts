import type { RunEvent } from "./types";
import { displayUserText } from "../../../extension/src/imageMarkers";

export type ChatBlock =
  | { kind: "user"; text: string; seq: number }
  | { kind: "assistant"; text: string; seq: number }
  | { kind: "thought"; text: string; seq: number }
  | { kind: "tool"; name: string; summary: string; seq: number }
  | { kind: "file"; path: string; seq: number }
  | {
    kind: "subagent";
    title: string;
    status: string;
    seq: number;
    id?: string;
    task?: string;
    cid?: string;
    text?: string;
    durationMs?: number;
    model?: string;
  };

type SubagentBlock = Extract<ChatBlock, { kind: "subagent" }>;

function normTask(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function betterTitle(a: string, b: string): string {
  const ag = !a || a === "子代理";
  const bg = !b || b === "子代理";
  if (ag && !bg) return b;
  if (bg && !ag) return a;
  return b || a;
}

function mergeSubagent(prev: SubagentBlock, next: SubagentBlock): SubagentBlock {
  const prevDone = prev.status === "completed" || prev.status === "error";
  const nextDone = next.status === "completed" || next.status === "error";
  return {
    kind: "subagent",
    seq: prev.seq,
    id: next.id || prev.id,
    title: betterTitle(prev.title, next.title),
    status: nextDone || !prevDone ? next.status : prev.status,
    task: normTask(next.task) ? next.task : prev.task,
    cid: next.cid || prev.cid,
    text: next.text || prev.text,
    durationMs: next.durationMs ?? prev.durationMs,
    model: next.model || prev.model,
  };
}

function subagentFromHook(p: any, status: string, seq: number): SubagentBlock {
  const title = String(p?.description || "").trim() || "子代理";
  return {
    kind: "subagent",
    seq,
    id: String(p?.subagent_id ?? "").trim() || undefined,
    title,
    status,
    task: typeof p?.task === "string" ? p.task : undefined,
    durationMs: typeof p?.duration_ms === "number" ? p.duration_ms : undefined,
    model: String(p?.subagent_model ?? p?.model ?? ""),
  };
}

function parsePayload(raw: string): any {
  try { return JSON.parse(raw); } catch { return null; }
}

/** 去掉 Cursor transcript 包的 timestamp / user_query 壳,只留人看的那句。 */
export function extractUserText(raw: string): string {
  const q = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (q) return q[1].trim();
  return raw.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, "").trim();
}

/** Cursor 协议注入的用户句，不是操作员输入；详情不画成气泡。不参与忙/闲。 */
function isCursorProtocolUser(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith("Perform any necessary follow-up actions") ||
    t.startsWith("Implement the plan as specified")
  );
}

function emitUser(text: string, seq: number): ChatBlock[] {
  if (!text || isCursorProtocolUser(text)) return [];
  return [{ kind: "user", text, seq }];
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? p;
}

function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;
  if (name === "Task") {
    const d = String(input.description ?? "").trim();
    return d ? `子代理 · ${d}` : "子代理";
  }
  const path = String(input.path ?? input.file_path ?? input.glob ?? input.glob_pattern ?? "");
  if (path) return `${name} · ${basename(path)}`;
  const pattern = String(input.pattern ?? "");
  if (pattern) return `${name} · ${pattern.slice(0, 40)}`;
  return name;
}

function transcriptBlocks(ev: RunEvent, p: any): ChatBlock[] {
  if (p?.type === "turn_ended") return [];
  const role = p?.role;
  const parts: any[] = Array.isArray(p?.message?.content) ? p.message.content : [];
  const out: ChatBlock[] = [];
  if (role === "user") {
    const text = parts.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("\n");
    const shown = displayUserText(extractUserText(text));
    return emitUser(shown, ev.seq);
  }
  if (role === "assistant") {
    for (const c of parts) {
      if (c?.type === "text" && c.text) out.push({ kind: "assistant", text: String(c.text), seq: ev.seq });
      if (c?.type === "tool_use" && c.name === "Task") {
        const input = (c.input ?? {}) as Record<string, unknown>;
        out.push({
          kind: "subagent",
          seq: ev.seq,
          title: String(input.description ?? "").trim() || "子代理",
          status: "running",
          task: typeof input.prompt === "string" ? input.prompt : undefined,
          model: String(input.model ?? ""),
        });
        continue;
      }
      if (c?.type === "tool_use" && c.name) {
        out.push({ kind: "tool", name: String(c.name), summary: toolSummary(String(c.name), c.input), seq: ev.seq });
      }
    }
  }
  return out;
}

function hookBlocks(ev: RunEvent, p: any): ChatBlock[] {
  const hook = ev.hook_event_name;
  if (hook === "beforeSubmitPrompt" && typeof p?.prompt === "string") {
    const ids = Array.isArray(p?.attachmentIds) ? p.attachmentIds : [];
    const shown = displayUserText(p.prompt, ids.length);
    return emitUser(shown, ev.seq);
  }
  if (hook === "afterAgentThought" && typeof p?.text === "string" && p.text.trim()) {
    return [{ kind: "thought", text: p.text.trim(), seq: ev.seq }];
  }
  if (hook === "preToolUse" && typeof p?.tool_name === "string") {
    return [{ kind: "tool", name: p.tool_name, summary: toolSummary(p.tool_name, p.tool_input), seq: ev.seq }];
  }
  if (hook === "afterFileEdit" && typeof p?.file_path === "string") {
    return [{ kind: "file", path: p.file_path, seq: ev.seq }];
  }
  if (hook === "afterAgentResponse" && typeof p?.text === "string" && p.text.trim()) {
    const text = p.text.trim().replace(/\[子代理\]\([^)]+\)\s*/g, "子代理 ");
    return [{ kind: "assistant", text, seq: ev.seq }];
  }
  if (hook === "subagentStart") {
    return [subagentFromHook(p, "running", ev.seq)];
  }
  if (hook === "subagentStop") {
    return [subagentFromHook(p, String(p?.status ?? "completed"), ev.seq)];
  }
  return [];
}

function dedupe(blocks: ChatBlock[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  const subById = new Map<string, number>();
  const subByTask = new Map<string, number>();
  let lastThought = "";
  for (const b of blocks) {
    if (b.kind === "thought") {
      if (b.text === lastThought) continue;
      lastThought = b.text;
    } else if (b.kind === "subagent") {
      const id = (b.id ?? "").trim();
      const task = normTask(b.task);
      let prev: number | undefined;
      if (id) prev = subById.get(id);
      if (prev === undefined && task) prev = subByTask.get(task);
      if (prev !== undefined) {
        const old = out[prev];
        if (old.kind === "subagent") {
          const merged = mergeSubagent(old, b);
          out[prev] = merged;
          if ((merged.id ?? "").trim()) subById.set(merged.id!.trim(), prev);
          if (normTask(merged.task)) subByTask.set(normTask(merged.task), prev);
        }
        continue;
      }
      if (id) subById.set(id, out.length);
      if (task) subByTask.set(task, out.length);
    }
    out.push(b);
  }
  return out;
}

function finish(blocks: ChatBlock[]): ChatBlock[] {
  const hasSub = blocks.some((b) => b.kind === "subagent");
  const filtered = hasSub ? blocks.filter((b) => !(b.kind === "tool" && b.name === "Task")) : blocks;
  return dedupe(filtered);
}

/** Stable by seq so same-seq transcript parts keep relative order. */
function orderBySeq(blocks: ChatBlock[]): ChatBlock[] {
  return blocks
    .map((b, i) => ({ b, i }))
    .sort((a, c) => a.b.seq - c.b.seq || a.i - c.i)
    .map(({ b }) => b);
}

/** extraUsers 里 hub+hook 同文案只留先到的一条；transcript 跨轮同句不走这里。 */
function uniqueUserText(blocks: ChatBlock[]): ChatBlock[] {
  const seen = new Set<string>();
  const out: ChatBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "user") {
      if (seen.has(b.text)) continue;
      seen.add(b.text);
    }
    out.push(b);
  }
  return out;
}

type ChildAcc = { cid: string; task: string; texts: string[] };

function takeChildLine(p: any): { cid: string; role: string; text: string } | null {
  const cid = typeof p?.__subagent_cid === "string" ? p.__subagent_cid : "";
  if (!cid) return null;
  const role = typeof p?.role === "string" ? p.role : "";
  const parts: any[] = Array.isArray(p?.message?.content) ? p.message.content : [];
  const text = parts.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("\n");
  return { cid, role, text };
}

function lastAssistant(texts: string[]): string {
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i]!.trim();
    if (t) return t;
  }
  return "";
}

function attachChildText(blocks: ChatBlock[], children: Map<string, ChildAcc>): ChatBlock[] {
  const unused = [...children.values()];
  return blocks.map((b) => {
    if (b.kind !== "subagent") return b;
    const i = unused.findIndex((c) =>
      (b.cid && c.cid === b.cid) || (normTask(c.task) !== "" && normTask(c.task) === normTask(b.task)),
    );
    if (i < 0) return b;
    const [c] = unused.splice(i, 1);
    if (!c) return b;
    return { ...b, cid: c.cid, text: lastAssistant(c.texts) || b.text };
  });
}

/**
 * 把 run_events 收成可读对话。
 * 有 transcript 时以它为骨架(和 IDE 一致);其后新到的 hook 作为「正在进行」补在末尾。
 * 尚无 transcript 时(刚开始跑)完全用 hook 拼。
 * 续聊 fromEnd tail 会丢掉首轮 jsonl:若更早的 hook 里已有助手回复,接到 transcript 前面。
 * 对不上 transcript 的用户句(extraUsers)按 seq 插回时间线,禁止整包垫在最新助手后面。
 * 续聊 hub 合成 BSP 与 Mac composer hook 同文案双发:extraUsers 按 text 留最早 seq。
 * 子代理卡片来自父 jsonl 的 Task tool_use；Start/Stop 按 subagent_id 或 task 合并；
 * 子代理 jsonl 只填卡片正文，不进父助手骨架。
 */
export function eventsToChat(events: RunEvent[]): ChatBlock[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const lastTx = sorted.reduce((m, e) => e.source === "transcript" ? Math.max(m, e.seq) : m, 0);
  const firstTx = sorted.reduce((m, e) => e.source === "transcript" ? Math.min(m, e.seq) : m, Infinity);
  const fromTx: ChatBlock[] = [];
  const pendingUsers: ChatBlock[] = [];
  const fromHooks: ChatBlock[] = [];
  const liveHooks: ChatBlock[] = [];
  const subFromHooks: ChatBlock[] = [];
  const children = new Map<string, ChildAcc>();

  for (const ev of sorted) {
    const p = parsePayload(ev.payload);
    if (!p) continue;
    if (ev.source === "subagent-transcript") {
      const line = takeChildLine(p);
      if (!line) continue;
      let acc = children.get(line.cid);
      if (!acc) { acc = { cid: line.cid, task: "", texts: [] }; children.set(line.cid, acc); }
      if (line.role === "user" && !acc.task) acc.task = extractUserText(line.text);
      if (line.role === "assistant" && line.text) acc.texts.push(line.text);
      continue;
    }
    if (ev.source === "transcript") {
      fromTx.push(...transcriptBlocks(ev, p));
      continue;
    }
    const hb = hookBlocks(ev, p);
    fromHooks.push(...hb);
    for (const b of hb) if (b.kind === "subagent") subFromHooks.push(b);
    if (lastTx === 0) {
      liveHooks.push(...hb);
      continue;
    }
    if (ev.hook_event_name === "beforeSubmitPrompt") {
      pendingUsers.push(...hb);
      continue;
    }
    if (ev.seq > lastTx) liveHooks.push(...hb);
  }

  const txUser = new Set(fromTx.filter((b) => b.kind === "user").map((b) => b.kind === "user" ? b.text : ""));
  const txAsst = new Set(fromTx.filter((b) => b.kind === "assistant").map((b) => b.kind === "assistant" ? b.text : ""));
  const dropTxDup = (b: ChatBlock) => {
    if (b.kind === "user" && txUser.has(b.text)) return false;
    if (b.kind === "assistant" && txAsst.has(b.text)) return false;
    return true;
  };
  const prefixHooks = Number.isFinite(firstTx) ? fromHooks.filter((b) => b.seq < firstTx).filter(dropTxDup) : [];
  const live = liveHooks.filter(dropTxDup);
  const prefixUser = new Set(prefixHooks.filter((b) => b.kind === "user").map((b) => b.kind === "user" ? b.text : ""));
  const extraUsers = uniqueUserText(
    pendingUsers.filter((b) => b.kind === "user" && !txUser.has(b.text) && !prefixUser.has(b.text)),
  );
  const skeleton = [...prefixHooks, ...fromTx];
  return attachChildText(finish(orderBySeq([...skeleton, ...extraUsers, ...live, ...subFromHooks])), children);
}

const PROCESS = new Set(["thought", "tool", "file", "subagent"]);

export type ProcessSegment = {
  kind: "process";
  collapsed: boolean;
  steps: ChatBlock[];
  seq: number;
};

export type ChatSegment = ChatBlock | ProcessSegment;

/** 详情「复制正文」：只拼助手回复，不含思考/工具/用户句。 */
export function assistantBodyText(blocks: ChatBlock[]): string {
  return blocks.filter((b) => b.kind === "assistant").map((b) => b.text).join("\n\n").trim();
}

/** 有正文后把该轮思考/工具收成一段；尚未出正文时保持一条条列出。 */
export function segmentChat(blocks: ChatBlock[]): ChatSegment[] {
  const turns: ChatBlock[][] = [];
  let cur: ChatBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "user" && cur.length > 0) {
      turns.push(cur);
      cur = [];
    }
    cur.push(b);
  }
  if (cur.length) turns.push(cur);

  const out: ChatSegment[] = [];
  for (const turn of turns) {
    if (!turn.some((b) => b.kind === "assistant")) {
      out.push(...turn);
      continue;
    }
    const buf: ChatBlock[] = [];
    const flush = () => {
      if (buf.length === 0) return;
      out.push({ kind: "process", collapsed: true, steps: [...buf], seq: buf[0].seq });
      buf.length = 0;
    };
    for (const b of turn) {
      if (PROCESS.has(b.kind)) buf.push(b);
      else {
        flush();
        out.push(b);
      }
    }
    flush();
  }
  return out;
}

