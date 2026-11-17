export type FollowupDraftEvent = {
  seq: number;
  source?: string;
  hook_event_name: string | null;
  payload: string;
};

export type FollowupOutbound = {
  prompt: string;
  state: string;
  created_at: number;
};

function readPayload(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function eventPrompt(ev: FollowupDraftEvent): string {
  const payload = readPayload(ev.payload);
  const prompt = payload?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

function isSubmittedUser(ev: FollowupDraftEvent): boolean {
  if (ev.hook_event_name === "beforeSubmitPrompt") return eventPrompt(ev).trim().length > 0;
  if (ev.source === "transcript") {
    const payload = readPayload(ev.payload);
    return payload?.role === "user";
  }
  return false;
}

/** 最近一次没发出去的续聊原文。后面已经有用户句时不再填回输入框。 */
export function rejectedFollowupDraft(events: FollowupDraftEvent[]): { seq: number; prompt: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (isSubmittedUser(ev)) return null;
    if (ev.hook_event_name !== "followupRejected") continue;
    const prompt = eventPrompt(ev);
    if (!prompt.trim()) return null;
    return { seq: ev.seq, prompt };
  }
  return null;
}

export function settleFollowupComposer(input: {
  awaiting: boolean;
  sawDispatched: boolean;
  status?: string;
  /** 这一轮提交出去的原文。输入框若已被改过，成功后也不覆盖。 */
  sent: string;
  draft: string;
  afterSeq: number;
  events: FollowupDraftEvent[];
  outbound?: FollowupOutbound[];
}): { awaiting: boolean; sawDispatched: boolean; draft: string; clearFiles: boolean } {
  if (!input.awaiting) {
    return { awaiting: false, sawDispatched: false, draft: input.draft, clearFiles: false };
  }
  const sawDispatched = input.sawDispatched || input.status === "dispatched" || input.status === "queued";
  const keep = { awaiting: false, sawDispatched, draft: input.draft, clearFiles: false };
  const unchanged = input.draft.trim() === input.sent.trim();
  const accept = unchanged
    ? { awaiting: false, sawDispatched, draft: "", clearFiles: true }
    : { awaiting: false, sawDispatched, draft: input.draft, clearFiles: false };
  for (const ev of input.events) {
    if (ev.seq <= input.afterSeq) continue;
    if (ev.hook_event_name === "followupRejected") return keep;
    if (ev.hook_event_name === "beforeSubmitPrompt" && eventPrompt(ev).trim()) return accept;
  }
  const outbound = [...(input.outbound ?? [])].reverse().find((row) => row.prompt === input.draft);
  if (outbound?.state === "failed") return keep;
  if (outbound && (outbound.state === "queued" || outbound.state === "steered")) return accept;
  if (sawDispatched && (input.status === "error" || input.status === "aborted" || input.status === "cancelled")) {
    return keep;
  }
  if (sawDispatched && (input.status === "binding" || input.status === "running" || input.status === "completed")) {
    return accept;
  }
  return { awaiting: true, sawDispatched, draft: input.draft, clearFiles: false };
}
