import type { RunEvent } from "./types";

export type ChatBlock =
  | { kind: "user"; text: string; seq: number }
  | { kind: "assistant"; text: string; seq: number }
  | { kind: "thought"; text: string; seq: number }
  | { kind: "tool"; name: string; summary: string; seq: number }
  | { kind: "file"; path: string; seq: number };

function parsePayload(raw: string): any {
  try { return JSON.parse(raw); } catch { return null; }
}

/** 去掉 Cursor transcript 包的 timestamp / user_query 壳,只留人看的那句。 */
export function extractUserText(raw: string): string {
  const q = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (q) return q[1].trim();
  return raw.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, "").trim();
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? p;
}

function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;
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
    const cleaned = extractUserText(text);
    if (cleaned) out.push({ kind: "user", text: cleaned, seq: ev.seq });
    return out;
  }
  if (role === "assistant") {
    for (const c of parts) {
      if (c?.type === "text" && c.text) out.push({ kind: "assistant", text: String(c.text), seq: ev.seq });
      if (c?.type === "tool_use" && c.name) {
        out.push({ kind: "tool", name: String(c.name), summary: toolSummary(String(c.name), c.input), seq: ev.seq });
      }
    }
  }
  return out;
}

function hookBlocks(ev: RunEvent, p: any): ChatBlock[] {
  const hook = ev.hook_event_name;
  if (hook === "beforeSubmitPrompt" && typeof p?.prompt === "string" && p.prompt.trim()) {
    return [{ kind: "user", text: p.prompt.trim(), seq: ev.seq }];
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
    return [{ kind: "assistant", text: p.text.trim(), seq: ev.seq }];
  }
  return [];
}

function dedupe(blocks: ChatBlock[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  const seenUser = new Set<string>();
  const seenAsst = new Set<string>();
  let lastThought = "";
  for (const b of blocks) {
    if (b.kind === "user") {
      if (seenUser.has(b.text)) continue;
      seenUser.add(b.text);
    } else if (b.kind === "assistant") {
      if (seenAsst.has(b.text)) continue;
      seenAsst.add(b.text);
    } else if (b.kind === "thought") {
      if (b.text === lastThought) continue;
      lastThought = b.text;
    }
    out.push(b);
  }
  return out;
}

/**
 * 把 run_events 收成可读对话。
 * 有 transcript 时以它为骨架(和 IDE 一致);其后新到的 hook 作为「正在进行」补在末尾。
 * 尚无 transcript 时(刚开始跑)完全用 hook 拼。
 */
export function eventsToChat(events: RunEvent[]): ChatBlock[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const lastTx = sorted.reduce((m, e) => e.source === "transcript" ? Math.max(m, e.seq) : m, 0);
  const fromTx: ChatBlock[] = [];
  const pendingUsers: ChatBlock[] = [];
  const liveHooks: ChatBlock[] = [];

  for (const ev of sorted) {
    const p = parsePayload(ev.payload);
    if (!p) continue;
    if (ev.source === "transcript") {
      fromTx.push(...transcriptBlocks(ev, p));
      continue;
    }
    if (lastTx === 0) {
      liveHooks.push(...hookBlocks(ev, p));
      continue;
    }
    if (ev.hook_event_name === "beforeSubmitPrompt") {
      pendingUsers.push(...hookBlocks(ev, p));
      continue;
    }
    if (ev.seq > lastTx) liveHooks.push(...hookBlocks(ev, p));
  }

  const txUser = new Set(fromTx.filter((b) => b.kind === "user").map((b) => b.kind === "user" ? b.text : ""));
  const extraUsers = pendingUsers.filter((b) => b.kind === "user" && !txUser.has(b.text));
  return dedupe([...fromTx, ...extraUsers, ...liveHooks]);
}
