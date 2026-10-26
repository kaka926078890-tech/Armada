import { hasImageMarkers, stripImageMarkers } from "../../extension/src/imageMarkers";
import { normalizePrompt } from "./concurrency";

export const OUTBOUND_LIMIT = 8;
export const QUEUE_DRAIN_MS = 120_000;

export function extractUserText(raw: string): string {
  const q = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (q) return q[1].trim();
  return raw.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, "").trim();
}

export function queueModeOf(raw: unknown): "queue" | "steer" | "unknown" {
  return raw === "queue" || raw === "steer" ? raw : "unknown";
}

/** Cursor 塞进 jsonl user 行的内部目录。必须带尖括号，避免只是提到这两个词。 */
export const CURSOR_INTERNAL_CONTEXT_MARKERS = [
  "<available_subagent_types>",
  "<available_subagent_models>",
] as const;

/** Cursor 协议注入的用户句前缀。只 startsWith 这些；对不上就当操作员输入。 */
export const CURSOR_PROTOCOL_USER_PREFIXES = [
  "Perform any necessary follow-up actions",
  "Implement the plan as specified",
  "Briefly inform the user about the task result",
] as const;

export function isCursorProtocolUser(text: string): boolean {
  const t = text.trim();
  return CURSOR_PROTOCOL_USER_PREFIXES.some((prefix) => t.startsWith(prefix));
}

function userMessageText(payload: any): string {
  const parts = Array.isArray(payload?.message?.content) ? payload.message.content : [];
  return parts.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n");
}

export function transcriptUserPrompt(payload: any): string | null {
  if (payload?.role !== "user") return null;
  const n = normalizePrompt(extractUserText(userMessageText(payload)));
  return n || null;
}

/** 这段用户正文能不能改 run 状态。内部目录返回 null。协议续聊仍返回正文。 */
export function statusUserPrompt(payload: unknown): string | null {
  const text = transcriptUserPrompt(payload);
  if (!text) return null;
  const raw = userMessageText(payload);
  if (CURSOR_INTERNAL_CONTEXT_MARKERS.some((marker) => raw.includes(marker))) return null;
  return text;
}

export function hookSubmitPrompt(payload: any): string | null {
  if (typeof payload?.prompt !== "string") return null;
  const n = normalizePrompt(extractUserText(payload.prompt));
  return n || null;
}

/** 认领续发：去掉 Cursor 的图片包装。只剩图时 text 为空、imageOnly 为真。 */
export function outboundClaimKey(raw: string): { text: string; imageOnly: boolean } | null {
  const text = stripImageMarkers(extractUserText(raw));
  if (text) return { text, imageOnly: false };
  if (hasImageMarkers(raw)) return { text: "", imageOnly: true };
  return null;
}

export function outboundClaimFromHook(payload: any): { text: string; imageOnly: boolean } | null {
  if (typeof payload?.prompt !== "string") return null;
  return outboundClaimKey(payload.prompt);
}

export function outboundClaimFromTranscript(payload: any): { text: string; imageOnly: boolean } | null {
  if (payload?.role !== "user") return null;
  const parts = Array.isArray(payload?.message?.content) ? payload.message.content : [];
  const raw = parts.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n");
  return outboundClaimKey(raw);
}
