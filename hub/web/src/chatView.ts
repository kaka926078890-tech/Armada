import type { RunEvent } from "./types";
import { displayUserText } from "../../../extension/src/imageMarkers";

export type ChatBlock =
  | { kind: "user"; text: string; seq: number }
  | { kind: "assistant"; text: string; seq: number }
  | { kind: "thought"; text: string; seq: number }
  | { kind: "turn_end"; seq: number }
  | { kind: "tool"; name: string; summary: string; seq: number; count?: number }
  | { kind: "file"; path: string; seq: number }
  | {
    kind: "ask";
    seq: number;
    request_id: string;
    prompt: string;
    options: { id: string; label: string; text: string }[];
    action: "pending" | "submitting" | "submit_failed" | "resolved";
    error?: string;
    askKind?: "plan";
    continueAllowed?: boolean;
  }
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
  const cid = typeof p?.conversation_id === "string" ? p.conversation_id.trim() : "";
  return {
    kind: "subagent",
    seq,
    id: String(p?.subagent_id ?? "").trim() || undefined,
    title,
    status,
    task: typeof p?.task === "string" ? p.task : undefined,
    cid: cid || undefined,
    durationMs: typeof p?.duration_ms === "number" ? p.duration_ms : undefined,
    model: String(p?.subagent_model ?? p?.model ?? ""),
  };
}

export const ASK_TOOL_NAME = "AskQuestion";

function askOptionsFromInput(input: Record<string, unknown> | undefined): { id: string; label: string; text: string }[] {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const q = questions[0] as Record<string, unknown> | undefined;
  const opts = Array.isArray(q?.options) ? q.options : [];
  const out: { id: string; label: string; text: string }[] = [];
  for (const item of opts) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) continue;
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : id;
    const text = typeof o.text === "string" && o.text.trim() ? o.text.trim() : label;
    out.push({ id, label, text });
  }
  return out;
}

function askPromptFromInput(input: Record<string, unknown> | undefined): string {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const q = questions[0] as Record<string, unknown> | undefined;
  const prompt = typeof q?.prompt === "string" ? q.prompt.trim() : "";
  return prompt || "Questions";
}

function askContinueAllowed(questions: { allow_multiple?: boolean }[]): boolean {
  return questions.length === 1 && questions[0]?.allow_multiple !== true;
}

function askKindOf(raw: unknown): "plan" | undefined {
  return raw === "plan" ? "plan" : undefined;
}

function askBlockFromPayload(p: any, seq: number, action: "pending" | "resolved"): ChatBlock | null {
  const questions = Array.isArray(p?.questions) ? p.questions : [];
  if (!questions.length) return null;
  const request_id = typeof p?.request_id === "string" && p.request_id.trim()
    ? p.request_id.trim()
    : `ask-hook-${seq}`;
  const q = questions[0] as Record<string, unknown>;
  const prompt = typeof q?.prompt === "string" && q.prompt.trim() ? q.prompt.trim() : "Questions";
  const options = askOptionsFromInput({ questions });
  if (!options.length) return null;
  return {
    kind: "ask",
    seq,
    request_id,
    prompt,
    options,
    action,
    askKind: askKindOf(p.kind),
    continueAllowed: askContinueAllowed(questions),
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

/** Cursor 协议注入的用户句前缀。只 startsWith 这些；对不上就当操作员输入画出来，不要 silently hide。 */
export const CURSOR_PROTOCOL_USER_PREFIXES = [
  "Perform any necessary follow-up actions",
  "Implement the plan as specified",
  "Briefly inform the user about the task result",
] as const;

/** Cursor 协议注入的用户句，不是操作员输入；详情不画成气泡。不参与忙/闲。 */
function isCursorProtocolUser(text: string): boolean {
  const t = text.trim();
  return CURSOR_PROTOCOL_USER_PREFIXES.some((prefix) => t.startsWith(prefix));
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
  if (p?.type === "turn_ended") return [{ kind: "turn_end", seq: ev.seq }];
  const role = p?.role;
  const parts: any[] = Array.isArray(p?.message?.content) ? p.message.content : [];
  const out: ChatBlock[] = [];
  if (role === "user") {
    const text = parts.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("\n");
    const shown = displayUserText(extractUserText(text));
    return emitUser(shown, ev.seq);
  }
  if (role === "assistant") {
    const hasToolUse = parts.some((c) => c?.type === "tool_use" && c.name);
    for (const c of parts) {
      if (c?.type === "text" && c.text) {
        out.push({ kind: hasToolUse ? "thought" : "assistant", text: String(c.text), seq: ev.seq });
      }
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
      if (c?.type === "tool_use" && c.name === ASK_TOOL_NAME) {
        const input = (c.input ?? {}) as Record<string, unknown>;
        const options = askOptionsFromInput(input);
        const questions = Array.isArray(input.questions) ? input.questions as { allow_multiple?: boolean }[] : [];
        if (options.length) {
          out.push({
            kind: "ask",
            seq: ev.seq,
            request_id: typeof c.id === "string" && c.id.trim() ? c.id.trim() : `ask-jsonl-${ev.seq}`,
            prompt: askPromptFromInput(input),
            options,
            action: "resolved",
            askKind: askKindOf(input.kind),
            continueAllowed: askContinueAllowed(questions),
          });
        }
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
  if (hook === "askQuestion") {
    const b = askBlockFromPayload(p, ev.seq, "pending");
    return b ? [b] : [];
  }
  if (hook === "askQuestionResolved") {
    const request_id = typeof p?.request_id === "string" ? p.request_id : "";
    if (!request_id) return [];
    return [{ kind: "ask", seq: ev.seq, request_id, prompt: "", options: [], action: "resolved" }];
  }
  return [];
}

function dedupe(blocks: ChatBlock[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  const subById = new Map<string, number>();
  const subByTask = new Map<string, number>();
  const askById = new Map<string, number>();
  let lastThought = "";
  const asstSeen = new Set<string>();
  for (const b of blocks) {
    if (b.kind === "user") {
      asstSeen.clear();
    }
    if (b.kind === "thought") {
      if (b.text === lastThought) continue;
      lastThought = b.text;
    } else if (b.kind === "assistant") {
      // jsonl 在 turn_ended 后再写同一轮：连续同文（A,A）或夹工具的 A/B/A/B 都只留先到的正文。
      // 操作员用户句清集合，跨轮同文回复仍是两条气泡。
      if (asstSeen.has(b.text)) continue;
      asstSeen.add(b.text);
    } else if (b.kind === "ask") {
      const prev = b.request_id ? askById.get(b.request_id) : undefined;
      if (prev !== undefined) {
        const old = out[prev];
        if (old.kind === "ask") {
          const merged: typeof old = {
            ...old,
            prompt: b.prompt || old.prompt,
            options: b.options.length ? b.options : old.options,
            action: b.action === "pending" ? old.action === "resolved" ? "pending" : b.action : b.action,
            error: b.error || old.error,
            request_id: b.request_id || old.request_id,
          };
          out[prev] = merged;
          if (merged.request_id) askById.set(merged.request_id, prev);
        }
        continue;
      }
      if (b.request_id) askById.set(b.request_id, out.length);
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

function lastAssistantBlock(blocks: ChatBlock[]): Extract<ChatBlock, { kind: "assistant" }> | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.kind === "assistant") return b;
  }
  return undefined;
}

/**
 * Cursor jsonl: one assistant line is one UI unit; turn_ended closes a generation.
 * Keep the last text-only of the first generation (operator answer) and of the last
 * generation (latest protocol status). Other assistants become thoughts.
 */
function applyCursorGenerations(blocks: ChatBlock[]): ChatBlock[] {
  const turns = splitChatTurns(blocks);
  const out: ChatBlock[] = [];
  for (const turn of turns) {
    const gens: ChatBlock[][] = [[]];
    for (const b of turn) {
      if (b.kind === "turn_end") {
        gens.push([]);
        continue;
      }
      gens[gens.length - 1]!.push(b);
    }
    while (gens.length > 1 && gens[gens.length - 1]!.length === 0) gens.pop();
    const first = lastAssistantBlock(gens[0] ?? []);
    const last = lastAssistantBlock(gens[gens.length - 1] ?? []);
    const keep = new Set<ChatBlock>();
    if (first) keep.add(first);
    if (last) keep.add(last);
    for (const gen of gens) {
      for (const b of gen) {
        if (b.kind === "assistant" && !keep.has(b)) {
          out.push({ kind: "thought", text: b.text, seq: b.seq });
        } else {
          out.push(b);
        }
      }
    }
  }
  return out;
}

function finish(blocks: ChatBlock[]): ChatBlock[] {
  const hasSub = blocks.some((b) => b.kind === "subagent");
  const filtered = hasSub ? blocks.filter((b) => !(b.kind === "tool" && b.name === "Task")) : blocks;
  return collapseRepeatedTools(applyCursorGenerations(dedupe(filtered)));
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
    const i = unused.findIndex((c) => !!(b.cid && c.cid === b.cid));
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
 * 续聊 hub 合成 BSP 与 Mac composer hook 同文案双发:所有 hook 用户句都走 extraUsers,按 text 留最早 seq。
 * prefixHooks 不含用户句,避免 fromEnd 下同一 BSP 在前缀里再画一次。
 * 子代理卡片来自父 jsonl 的 Task tool_use；Start/Stop 按 subagent_id 或 task 合并；
 * 子代理 jsonl 只填卡片正文，不进父助手骨架。
 * 协议轮用户句隐藏后，同一折里 jsonl 重放的同文助手只留先到的一条（含 A/B/A/B）。
 * 与 Cursor 一致：同行 text+tool_use 是过程旁白；turn_ended 切 generation；
 * 操作员折只留第一代最后正文 + 最后一代状态，其余助手进思考。
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
    // Hook 用户句一律进 pendingUsers，由 extraUsers uniqueUserText 收口。
    // lastTx===0 时若跟 thought/AAR 一起进 liveHooks，hub+composer 双 BSP 会画出两条相同气泡。
    if (ev.hook_event_name === "beforeSubmitPrompt") {
      pendingUsers.push(...hb);
      continue;
    }
    if (lastTx === 0) {
      liveHooks.push(...hb);
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
  // 前缀只留助手/过程；用户句走 extraUsers，避免 fromEnd 下 hub+hook 同文案在 prefix 里各画一条。
  const prefixHooks = Number.isFinite(firstTx)
    ? fromHooks.filter((b) => b.seq < firstTx && b.kind !== "user").filter(dropTxDup)
    : [];
  const live = liveHooks.filter(dropTxDup);
  const extraUsers = uniqueUserText(
    pendingUsers.filter((b) => b.kind === "user" && !txUser.has(b.text)),
  );
  const skeleton = [...prefixHooks, ...fromTx];
  return attachChildText(finish(orderBySeq([...skeleton, ...extraUsers, ...live, ...subFromHooks])), children);
}

export type PendingAskView = {
  request_id: string;
  kind?: "plan";
  questions: { prompt: string; allow_multiple?: boolean; options: { id: string; label: string; text: string }[] }[];
};

export function mergePendingAsk(blocks: ChatBlock[], pending: PendingAskView | null | undefined): ChatBlock[] {
  if (!pending?.request_id || !pending.questions?.[0]) {
    return blocks.map((b) => (b.kind === "ask" && b.action === "pending" ? { ...b, action: "resolved" as const } : b));
  }
  const q = pending.questions[0];
  const card: Extract<ChatBlock, { kind: "ask" }> = {
    kind: "ask",
    seq: Number.MAX_SAFE_INTEGER,
    request_id: pending.request_id,
    prompt: q.prompt,
    options: q.options ?? [],
    action: "pending",
    askKind: askKindOf(pending.kind),
    continueAllowed: askContinueAllowed(pending.questions),
  };
  const idx = blocks.findIndex((b) => b.kind === "ask" && b.request_id === pending.request_id);
  if (idx < 0) return [...blocks, card];
  const copy = [...blocks];
  const old = copy[idx];
  if (old.kind === "ask") copy[idx] = { ...old, ...card, seq: old.seq };
  return copy;
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

/** Snap / App 终态正文：最后一折助手，不按 prompt 对齐。 */
export function lastTurnAssistantBody(blocks: ChatBlock[]): string {
  return assistantBodyText(splitChatTurns(blocks).at(-1) ?? blocks);
}

function normPrompt(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 中转详情只取本轮（匹配 prompt 的那一折）助手正文，不含同一对话更早的任务。 */
export function assistantBodyForPrompt(blocks: ChatBlock[], prompt: string): string {
  const turns = splitChatTurns(blocks);
  const p = normPrompt(extractUserText(prompt));
  const pick = (pred: (u: string) => boolean): string => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const user = turns[i].find((b) => b.kind === "user");
      if (user?.kind !== "user") continue;
      if (!pred(normPrompt(user.text))) continue;
      const body = assistantBodyText(turns[i]);
      if (body) return body;
    }
    return "";
  };
  if (p) {
    const exact = pick((u) => u === p);
    if (exact) return exact;
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const body = assistantBodyText(turns[i]);
    if (body) return body;
  }
  return assistantBodyText(blocks);
}

/** 有正文后把该轮思考/工具收成一段；尚未出正文时同样折叠（Cursor 生成中也不平铺工具墙）。 */
export function segmentChat(blocks: ChatBlock[]): ChatSegment[] {
  const turns = splitChatTurns(blocks);
  const out: ChatSegment[] = [];
  for (const turn of turns) {
    const buf: ChatBlock[] = [];
    const flush = () => {
      if (buf.length === 0) return;
      out.push({ kind: "process", collapsed: true, steps: [...buf], seq: buf[0]!.seq });
      buf.length = 0;
    };
    for (const b of turn) {
      if (b.kind === "turn_end") continue;
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

export const INITIAL_VISIBLE_TURNS = 3;

export function splitChatTurns(blocks: ChatBlock[]): ChatBlock[][] {
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
  return turns;
}

export function initialHiddenPrefixTurns(blocks: ChatBlock[], keep = INITIAL_VISIBLE_TURNS): number {
  return Math.max(0, splitChatTurns(blocks).length - keep);
}

export function recentTurnsWindow(blocks: ChatBlock[], hiddenPrefixTurns: number): ChatBlock[] {
  const turns = splitChatTurns(blocks);
  if (turns.length === 0) return blocks;
  const start = Math.min(Math.max(0, hiddenPrefixTurns), turns.length);
  return turns.slice(start).flat();
}

export type OutboundRow = {
  id: string;
  prompt: string;
  expected_mode: string;
  state: string;
  created_at: number;
};

function isQueueMode(mode: string): boolean {
  return mode === "queue";
}

/** 托盘：queue 配置下 injecting/queued。steer/unknown 不进托盘。 */
export function queuedOutbound(outbound: OutboundRow[] | null | undefined): OutboundRow[] {
  return (outbound ?? []).filter((o) =>
    o.state === "queued" || (o.state === "injecting" && isQueueMode(o.expected_mode)),
  );
}

/** steered / injecting(非 queue) 乐观用户句；jsonl 同文到达后只留 transcript。 */
export function mergeOutboundChat(blocks: ChatBlock[], outbound: OutboundRow[] | null | undefined): ChatBlock[] {
  if (!outbound?.length) return blocks;
  const seen = new Set(
    blocks.filter((b): b is Extract<ChatBlock, { kind: "user" }> => b.kind === "user")
      .map((b) => normPrompt(extractUserText(b.text))),
  );
  const extra: ChatBlock[] = [];
  let seq = (blocks.at(-1)?.seq ?? 0) + 1;
  for (const o of outbound) {
    if (isQueueMode(o.expected_mode)) continue;
    if (o.state !== "injecting" && o.state !== "steered") continue;
    const n = normPrompt(extractUserText(o.prompt));
    if (!n || seen.has(n)) continue;
    extra.push({ kind: "user", text: o.prompt, seq: seq++ });
    seen.add(n);
  }
  return extra.length ? [...blocks, ...extra] : blocks;
}

/** Consecutive identical tools (same name+summary) become one row with count. */
export function collapseRepeatedTools(blocks: ChatBlock[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  for (const b of blocks) {
    const prev = out.at(-1);
    if (
      b.kind === "tool" && prev?.kind === "tool"
      && prev.name === b.name && prev.summary === b.summary
    ) {
      out[out.length - 1] = { ...prev, count: (prev.count ?? 1) + (b.count ?? 1) };
      continue;
    }
    out.push(b);
  }
  return out;
}

/** Cursor-like compact process header: last tool + × N, else step count. */
export function processFoldLabel(steps: ChatBlock[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const b = steps[i];
    if (b?.kind !== "tool") continue;
    const times = b.count && b.count > 1 ? ` × ${b.count}` : "";
    return `思考过程 · ${b.summary}${times}`;
  }
  return `思考过程 · ${steps.length} 步`;
}


