import { workspacePathIn } from "./workspacePath";

export interface HubRunRow {
  id: string;
  machine_id: string;
  status: string;
  conversation_id: string | null;
  workspace_root: string;
  prompt?: string;
  live_generation_id?: string | null;
  window_id?: string | null;
  window_connected?: boolean;
}

export interface AdoptTarget {
  runId: string;
  conversationId: string;
  workspaceRoot: string;
  prompt: string;
  liveGenerationId?: string;
}

export type AdoptWindow = { windowId: string; openWorkspaces: string[] };

/** Hub runs this window must re-attach after Reload (in-memory boundRuns is gone). */
export function hubRunsNeedingTranscriptFollow(machineId: string, runs: HubRunRow[], win: AdoptWindow): AdoptTarget[] {
  const live = new Set(["running", "binding"]);
  const out: AdoptTarget[] = [];
  for (const r of runs) {
    if (r.machine_id !== machineId) continue;
    if (!live.has(r.status)) continue;
    if (!r.conversation_id) continue;
    if (!r.workspace_root) continue;
    if (!workspacePathIn(r.workspace_root, win.openWorkspaces)) continue;
    // Another live Cursor window already tails this cid; Reload sets window_connected false.
    if (r.window_id && r.window_id !== win.windowId && r.window_connected === true) continue;
    out.push({
      runId: r.id,
      conversationId: r.conversation_id,
      workspaceRoot: r.workspace_root,
      prompt: r.prompt ?? "",
      liveGenerationId: typeof r.live_generation_id === "string" ? r.live_generation_id : undefined,
    });
  }
  return out;
}

/**
 * WS reconnect re-runs adopt while the live tail is still in memory.
 * Re-arming would wait for a user line that was already consumed, then drop
 * this turn's synthesized stop (card stuck 运行中).
 *
 * Fresh adopt (Reload: boundRuns empty) still arms when EOF is already
 * turn_ended, so maybeCompleteFromDisk does not close a new followup with
 * the previous turn's stop.
 */
export function shouldArmFollowupStopOnAdopt(input: {
  alreadyBound: boolean;
  lastRecordIsTurnEnded: boolean;
}): boolean {
  if (input.alreadyBound) return false;
  return input.lastRecordIsTurnEnded;
}
