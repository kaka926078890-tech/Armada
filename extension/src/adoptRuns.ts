export interface HubRunRow {
  id: string;
  machine_id: string;
  status: string;
  conversation_id: string | null;
  workspace_root: string;
  prompt?: string;
}

export interface AdoptTarget {
  runId: string;
  conversationId: string;
  workspaceRoot: string;
  prompt: string;
}

/** Hub runs this window must re-attach after Reload (in-memory boundRuns is gone). */
export function hubRunsNeedingTranscriptFollow(machineId: string, runs: HubRunRow[]): AdoptTarget[] {
  const live = new Set(["running", "binding"]);
  const out: AdoptTarget[] = [];
  for (const r of runs) {
    if (r.machine_id !== machineId) continue;
    if (!live.has(r.status)) continue;
    if (!r.conversation_id) continue;
    if (!r.workspace_root) continue;
    out.push({
      runId: r.id,
      conversationId: r.conversation_id,
      workspaceRoot: r.workspace_root,
      prompt: r.prompt ?? "",
    });
  }
  return out;
}
