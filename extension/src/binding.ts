import { workspacePathIn } from "./workspacePath";
import { normalizePrompt } from "./promptNormalize";

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

export interface AmbiguousBinding {
  ambiguous: true;
  runs: PendingRun[];
}

export type HookMatch = BindingMatch | AmbiguousBinding;

const TOLERANCE_MS = 5_000;

const BIND_HOOKS = new Set(["beforeSubmitPrompt"]);

/** PowerShell → native exe often turns CJK into "?" / U+FFFD. Recoverable only if one run is waiting. */
export function isGarbledHookPrompt(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return false;
  if (/^\?+$/.test(t)) return true;
  return t.includes("\uFFFD");
}

export function eventBelongsToWindow(raw: Record<string, unknown> | undefined, openWorkspaces: string[]): boolean {
  const roots = Array.isArray(raw?.workspace_roots)
    ? (raw!.workspace_roots as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (roots.length === 0 || openWorkspaces.length === 0) return false;
  return roots.some((r) => workspacePathIn(r, openWorkspaces));
}

export function isAmbiguousMatch(m: HookMatch | null): m is AmbiguousBinding {
  return m != null && "ambiguous" in m && m.ambiguous === true;
}

export function dropPendingRuns(pending: PendingRun[], runs: PendingRun[]): void {
  const ids = new Set(runs.map((r) => r.runId));
  for (let i = pending.length - 1; i >= 0; i--) {
    const row = pending[i];
    if (row && ids.has(row.runId)) pending.splice(i, 1);
  }
}

export function matchHookToPending(pending: PendingRun[], ev: HookEventView): HookMatch | null {
  // 只在真正提交且 prompt 与派发原文一致时绑定。
  // sessionStart 在 chat 创建瞬间就触发,会让 run 虚假进入 running。
  // afterSubmitPrompt 无 prompt,不得单独 bind(同工作区其它对话会误挂)。
  if (!BIND_HOOKS.has(ev.hook)) return null;
  const cid = ev.raw?.conversation_id;
  if (!cid || typeof cid !== "string") return null;
  const roots: string[] = Array.isArray(ev.raw?.workspace_roots) ? ev.raw.workspace_roots : [];
  const evMs = ev.ts * 1000;
  const prompt = typeof ev.raw?.prompt === "string" ? normalizePrompt(ev.raw.prompt) : "";
  if (!prompt) return null;
  const hits = pending.filter((p) =>
    workspacePathIn(p.workspaceRoot, roots)
    && evMs >= p.dispatchedAt - TOLERANCE_MS
    && normalizePrompt(p.prompt) === prompt,
  );
  if (hits.length > 1) {
    return { ambiguous: true as const, runs: hits };
  }
  if (hits.length !== 1) {
    if (!isGarbledHookPrompt(prompt)) return null;
    // PowerShell → native exe re-encodes CJK to "???". One waiting run in this
    // workspace+time window is still unambiguous (CDP just submitted it).
    const unique = pending.filter((p) =>
      workspacePathIn(p.workspaceRoot, roots)
      && evMs >= p.dispatchedAt - TOLERANCE_MS,
    );
    if (unique.length !== 1) return null;
    const run = unique[0]!;
    return {
      run,
      conversationId: cid,
      transcriptPath: typeof ev.raw?.transcript_path === "string" ? ev.raw.transcript_path : null,
      promptMatch: "edited",
    };
  }
  const run = hits[0]!;
  return {
    run,
    conversationId: cid,
    transcriptPath: typeof ev.raw?.transcript_path === "string" ? ev.raw.transcript_path : null,
    promptMatch: true,
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

export function transcriptPathBelongsToCid(path: string, cid: string): boolean {
  if (!path || !cid) return false;
  const norm = path.replace(/\\/g, "/");
  const marker = `/agent-transcripts/${cid}/`;
  if (!norm.includes(marker)) return false;
  return norm.endsWith(`/${cid}.jsonl`) || norm.includes(`${marker}subagents/`);
}

export function runIdForHook(
  bound: Iterable<[string, { conversationId: string }]>,
  children: Map<string, string>,
  conversationId: string | undefined,
): string | undefined {
  const owner = latestRunIdForConversation(bound, conversationId);
  if (owner) return owner;
  if (!conversationId) return undefined;
  return children.get(conversationId);
}

export function rememberSubagent(
  children: Map<string, string>,
  bound: Iterable<[string, { conversationId: string }]>,
  hook: string,
  raw: Record<string, unknown> | undefined,
): void {
  if (hook !== "subagentStart" || !raw) return;
  const child = raw.conversation_id;
  const parent = raw.parent_conversation_id;
  if (typeof child !== "string" || typeof parent !== "string") return;
  const owner = latestRunIdForConversation(bound, parent);
  if (owner) children.set(child, owner);
}
