import { normalizePrompt } from "../../extension/src/promptNormalize";
import { RETRY_STATUSES } from "./runStatus";
export { normalizePrompt };

export {
  OCCUPYING_STATUSES,
  INJECTING_STATUSES,
  PROGRESSING_STATUSES,
  RETRY_STATUSES,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  LIVE_STATUSES,
  ENDED_STATUSES,
  sqlStatusIn,
  isStatus,
} from "./runStatus";

/** Same gate as `runs.retry()`: error / unknown / aborted. */
export function canRetryStatus(status: string): boolean {
  return (RETRY_STATUSES as readonly string[]).includes(status);
}

/** Live followup queues outbound; idle followup injects a new turn. Clients must read this, not 200 vs 201. */
export function followupOutcome(status: string): "queued" | "injected" {
  return status === "running" ? "queued" : "injected";
}

export interface ConcurrencyLimits {
  maxPerMachine: number;
  maxPerWorkspace: number;
  multiRunPerWindow: boolean;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw == null || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): ConcurrencyLimits {
  const maxPerMachine = clampInt(env.ARMADA_MAX_RUNS_PER_MACHINE, 8, 1, 32);
  let maxPerWorkspace = clampInt(env.ARMADA_MAX_RUNS_PER_WORKSPACE, 4, 1, 16);
  if (maxPerWorkspace > maxPerMachine) maxPerWorkspace = maxPerMachine;
  const flag = (env.ARMADA_MULTI_RUN_PER_WINDOW ?? "1").trim();
  return { maxPerMachine, maxPerWorkspace, multiRunPerWindow: flag !== "0" };
}

export function extensionSupportsMultiRunPerWindow(version: string | null | undefined): boolean {
  const m = String(version ?? "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  const a = m ? Number(m[1]) : 0;
  const b = m ? Number(m[2]) : 0;
  const c = m ? Number(m[3]) : 0;
  if (a !== 0) return a > 0;
  if (b !== 4) return b > 4;
  return c >= 0;
}

export function httpStatusForRunError(error: string): 400 | 404 | 409 | 413 | 429 {
  if (error === "RUN_LIMIT" || error === "RATE_LIMIT" || error === "OUTBOUND_LIMIT") return 429;
  if (error === "NOT_FOUND" || error === "FILE_NOT_FOUND") return 404;
  if (error === "ATTACHMENT_TOO_LARGE" || error === "ATTACHMENT_TOTAL_TOO_LARGE" || error === "FILE_TOO_LARGE") return 413;
  if ([
    "PROMPT_COLLISION", "CONVERSATION_BUSY", "INJECT_SLOT_BUSY", "WINDOW_BUSY",
    "ALREADY_ACTIVE", "RUN_BUSY", "NO_CONVERSATION", "INVALID_STATE", "ALREADY_TERMINAL",
    "NO_PENDING_ASK", "ASK_MISMATCH", "ASK_IN_FLIGHT", "ASK_INVALID_OPTION",
    "ASK_TEXT_EMPTY", "ASK_TEXT_TOO_LONG", "OUTBOUND_TEXT_ONLY",
    "FILE_VIEW_UNSUPPORTED",
  ].includes(error)) return 409;
  return 400;
}
