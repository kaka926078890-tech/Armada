/** WKWebView says "Load failed"; Chromium says "Failed to fetch". Neither includes an HTTP status. */
export function isFollowupTransportError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return text.includes("Load failed") || text.includes("Failed to fetch");
}

export const FOLLOWUP_TRANSPORT_MISS = "发送结果没有回到看板。先看对话是否已经在跑，确认没有再发一次。";

/**
 * The followup POST can commit on the hub and still throw in the webview.
 * A newer started_at means the idle followup reopened the card.
 * A matching outbound row means a live followup was queued.
 */
export function followupLandedAfterTransportError(input: {
  prompt: string;
  sentAt: number;
  before: { startedAt?: number | null };
  after: {
    startedAt?: number | null;
    outbound?: { prompt: string; state: string; created_at: number }[];
  };
}): boolean {
  const prompt = input.prompt.trim();
  const outboundHit = prompt.length > 0 && (input.after.outbound ?? []).some((row) =>
    row.prompt.trim() === prompt
    && row.state !== "failed"
    && row.created_at >= input.sentAt - 2_000
  );
  if (outboundHit) return true;
  const beforeStarted = input.before.startedAt ?? 0;
  const afterStarted = input.after.startedAt ?? 0;
  return afterStarted > beforeStarted;
}
