export function genOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Cursor Windows 扩展上报 `win32` / `win32-x64`；该平台不装 Armada hooks。 */
export function isWindowsMachineOs(os: string | null | undefined): boolean {
  return typeof os === "string" && os.toLowerCase().startsWith("win32");
}

export function parseRetiredIds(raw: unknown): { ids: string[]; parseFailed: boolean } {
  if (raw == null || raw === "") return { ids: [], parseFailed: false };
  if (Array.isArray(raw)) {
    return { ids: raw.filter((x): x is string => typeof x === "string"), parseFailed: false };
  }
  if (typeof raw !== "string") return { ids: [], parseFailed: true };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ids: [], parseFailed: true };
    return { ids: parsed.filter((x): x is string => typeof x === "string"), parseFailed: false };
  } catch {
    return { ids: [], parseFailed: true };
  }
}

export function appendRetired(ids: string[], gen: string | null | undefined, cap = 32): string[] {
  const g = genOf(gen);
  if (!g) return ids;
  const next = ids.includes(g) ? ids : [...ids, g];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export type ArmInput = {
  hookEventName: string | null | undefined;
  generationId: unknown;
  eventCid: unknown;
  runConversationId: string | null | undefined;
  liveGenerationId: string | null | undefined;
  retired: string[];
};

export type ArmDecision =
  | { action: "arm"; gen: string }
  | { action: "rearm"; gen: string; retire: string }
  | { action: "skip"; reason: string };

const STANDARD_GEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStandardGenerationId(gen: string): boolean {
  return STANDARD_GEN_RE.test(gen);
}

export function decideArm(input: ArmInput): ArmDecision {
  const hook = input.hookEventName;
  const gen = genOf(input.generationId);
  if (hook === "preToolUse") {
    if (!gen) return { action: "skip", reason: "no_gen" };
    if (!isStandardGenerationId(gen)) return { action: "skip", reason: "sidecar_gen" };
  } else if (hook !== "beforeSubmitPrompt") {
    return { action: "skip", reason: "not_bsp" };
  } else if (!gen) {
    return { action: "skip", reason: "no_gen" };
  }
  if (!gen) return { action: "skip", reason: "no_gen" };
  const cid = typeof input.eventCid === "string" ? input.eventCid : null;
  const owner = input.runConversationId ?? null;
  if (!cid || !owner || cid !== owner) return { action: "skip", reason: "cid_mismatch" };
  if (gen === cid) return { action: "skip", reason: "gen_eq_cid" };
  if (input.retired.includes(gen)) return { action: "skip", reason: "retired" };
  if (input.liveGenerationId && input.liveGenerationId === gen) return { action: "skip", reason: "already_armed_same" };
  if (input.liveGenerationId) return { action: "rearm", gen, retire: input.liveGenerationId };
  return { action: "arm", gen };
}

export type StopInput = {
  stopCid: unknown;
  runConversationId: string | null | undefined;
  stopGenerationId: unknown;
  liveGenerationId: string | null | undefined;
  hasHubFollowup: boolean;
  retired: string[];
  /** Live composer already has afterAgentResponse; Cursor may then stop a sidecar gen. */
  liveTurnSettled?: boolean;
  /** Cursor queue still has unconsumed follow-ups (`run_outbound.state=queued`). */
  hasOutstandingOutbound?: boolean;
  /** Child jsonl still open (`subagent-transcript` without `turn_ended`). */
  hasOutstandingBackground?: boolean;
  /** `completed`/`success` may drain; abort/error still apply. */
  stopStatus?: unknown;
};

export type StopDecision =
  | { action: "apply"; audit?: "STOP_NO_GEN_INITIAL" | "STOP_SESSION_GEN" }
  | { action: "ignore"; audit: string };

export function decideStop(input: StopInput): StopDecision {
  const owner = input.runConversationId ?? null;
  const stopCid = typeof input.stopCid === "string" && input.stopCid ? input.stopCid : null;
  if (stopCid && owner && stopCid !== owner) return { action: "ignore", audit: "STOP_CID_MISMATCH" };
  const gen = genOf(input.stopGenerationId);
  if (gen && input.retired.includes(gen)) return { action: "ignore", audit: "STOP_GEN_RETIRED" };
  const live = genOf(input.liveGenerationId);
  let next: StopDecision;
  if (gen && live && gen === live) next = { action: "apply" };
  else if (gen && live && gen !== live) {
    next = input.liveTurnSettled
      ? { action: "apply", audit: "STOP_SESSION_GEN" }
      : { action: "ignore", audit: "STOP_GEN_MISMATCH" };
  } else if (gen && !live) next = { action: "ignore", audit: "STOP_UNARMED" };
  else if (!gen && live) next = { action: "ignore", audit: "STOP_NO_GEN" };
  else if (!gen && !live && input.hasHubFollowup) next = { action: "ignore", audit: "STOP_NO_GEN" };
  else next = { action: "apply", audit: "STOP_NO_GEN_INITIAL" };
  if (next.action === "apply" && input.hasOutstandingOutbound) {
    const s = input.stopStatus;
    if (s === "aborted" || s === "error") return next;
    return { action: "ignore", audit: "QUEUE_DRAIN" };
  }
  if (next.action === "apply" && input.hasOutstandingBackground) {
    const s = input.stopStatus;
    if (s === "aborted" || s === "error") return next;
    return { action: "ignore", audit: "BG_DRAIN" };
  }
  return next;
}

/** Cursor `sessionEnd` is session teardown, not turn-complete.
 *  `final_status=generating` means the agent loop is still running (r-a0bc34a5 18:05:27).
 *  Non-generating teardown maps onto the documented `stop` contract so hub idle matches Composer. */
export function stopFromCursorSessionEnd(payload: unknown): {
  status: string;
  generation_id: unknown;
  conversation_id: unknown;
  error?: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const finalStatus = typeof p.final_status === "string" ? p.final_status : "";
  if (!finalStatus || finalStatus === "generating") return null;
  const reason = typeof p.reason === "string" ? p.reason : "";
  const cid = p.conversation_id ?? p.session_id;
  const gen = p.generation_id;
  if (finalStatus === "error" || reason === "error") {
    return {
      status: "error",
      generation_id: gen,
      conversation_id: cid,
      error: typeof p.error_message === "string" ? p.error_message : "error",
    };
  }
  if (reason === "aborted" || (finalStatus === "aborted" && reason !== "user_close" && reason !== "window_close")) {
    return { status: "aborted", generation_id: gen, conversation_id: cid };
  }
  if (finalStatus === "completed" || finalStatus === "success" || reason === "completed") {
    return { status: "completed", generation_id: gen, conversation_id: cid };
  }
  if (reason === "user_close" || reason === "window_close") {
    return { status: "completed", generation_id: gen, conversation_id: cid };
  }
  return null;
}

/** Cursor 自己续轮空转后停掉当前 turn，随即会在同一条 jsonl 里追问。 */
export const RESUME_STALL_ERROR = "Agent turn stopped after repeated resume attempts made no progress";

export function isResumeStallError(reason: unknown): boolean {
  return reason === RESUME_STALL_ERROR;
}

/** Owner jsonl `turn_ended` is the durable idle signal. Hooks and synth stop can miss it. */
export function stopFromJsonlTurnEnded(payload: unknown): { status: string; error?: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "turn_ended") return null;
  const s = typeof p.status === "string" ? p.status : "";
  if (s === "aborted" || s === "cancelled" || s === "canceled") return { status: "aborted" };
  if (s === "error") return { status: "error", error: typeof p.error === "string" ? p.error : "error" };
  return { status: "completed" };
}
