export interface PendingRun {
  runId: string;
  workspaceRoot: string;
  prompt: string;
  dispatchedAt: number; // epoch ms
}

export interface HookEventView {
  hook: string;
  ts: number; // epoch seconds (spool wrapper field __ts)
  raw: any;
}

export interface BindingMatch {
  run: PendingRun;
  conversationId: string;
  transcriptPath: string | null;
  promptMatch: true | false | "edited";
}

const TOLERANCE_MS = 5_000;

export function matchHookToPending(pending: PendingRun[], ev: HookEventView): BindingMatch | null {
  if (ev.hook !== "sessionStart" && ev.hook !== "beforeSubmitPrompt") return null;
  const cid = ev.raw?.conversation_id;
  if (!cid || typeof cid !== "string") return null;
  const roots: string[] = Array.isArray(ev.raw?.workspace_roots) ? ev.raw.workspace_roots : [];
  const evMs = ev.ts * 1000;
  const candidates = pending
    .filter((p) => roots.includes(p.workspaceRoot) && evMs >= p.dispatchedAt - TOLERANCE_MS)
    .sort((a, b) => a.dispatchedAt - b.dispatchedAt);
  const run = candidates[0];
  if (!run) return null;
  let promptMatch: BindingMatch["promptMatch"] = false;
  if (ev.hook === "beforeSubmitPrompt" && typeof ev.raw?.prompt === "string") {
    promptMatch = ev.raw.prompt === run.prompt ? true : "edited";
  }
  return {
    run,
    conversationId: cid,
    transcriptPath: typeof ev.raw?.transcript_path === "string" ? ev.raw.transcript_path : null,
    promptMatch,
  };
}
