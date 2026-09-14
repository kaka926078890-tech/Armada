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

export function transcriptUserPrompt(payload: any): string | null {
  if (payload?.role !== "user") return null;
  const parts = Array.isArray(payload?.message?.content) ? payload.message.content : [];
  const text = parts.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n");
  const n = normalizePrompt(extractUserText(text));
  return n || null;
}

export function hookSubmitPrompt(payload: any): string | null {
  if (typeof payload?.prompt !== "string") return null;
  const n = normalizePrompt(extractUserText(payload.prompt));
  return n || null;
}
