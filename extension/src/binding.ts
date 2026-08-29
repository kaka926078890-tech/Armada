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
  // 只在 beforeSubmitPrompt 绑定:sessionStart 在 chat 创建瞬间(composer.newAgentChat)就触发,
  // 此时提示词可能尚未粘贴/回车,绑定会让 run 虚假进入 running(真机联调实测)。
  // beforeSubmitPrompt = 用户真正提交,且携带 prompt(可校验)与 transcript_path(可尾随)。
  if (ev.hook !== "beforeSubmitPrompt") return null;
  const cid = ev.raw?.conversation_id;
  if (!cid || typeof cid !== "string") return null;
  const roots: string[] = Array.isArray(ev.raw?.workspace_roots) ? ev.raw.workspace_roots : [];
  const evMs = ev.ts * 1000;
  // 多个候选时取最近派发的:刚打开的 chat 属于最近一次注入;
  // 最早优先会被"超时后才完成注入"的过期 pending 抢走绑定(真机联调实测)。
  const candidates = pending
    .filter((p) => roots.includes(p.workspaceRoot) && evMs >= p.dispatchedAt - TOLERANCE_MS)
    .sort((a, b) => b.dispatchedAt - a.dispatchedAt);
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

/** 同一 conversation 被多次绑定时取最后一次(最新 run)。Map 插入序下 find-first 会把 stop 送给已完成的旧任务。 */
export function latestRunIdForConversation(
  bound: Iterable<[string, { conversationId: string }]>,
  conversationId: string | undefined,
): string | undefined {
  if (!conversationId) return undefined;
  let last: string | undefined;
  for (const [runId, v] of bound) {
    if (v.conversationId === conversationId) last = runId;
  }
  return last;
}

/** 绑定新 run 时踢掉同 conversation 的旧条目,使 conversation 只有一个活主人。 */
export function claimConversation(
  bound: Map<string, { conversationId: string; prompt: string }>,
  runId: string,
  conversationId: string,
  prompt: string,
): void {
  for (const [id, v] of bound) {
    if (v.conversationId === conversationId) bound.delete(id);
  }
  bound.set(runId, { conversationId, prompt });
}
