import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { hasImageMarkers, stripImageMarkers } from "./imageMarkers";
import { normalizePrompt } from "./promptNormalize";
import { normalizeWorkspacePath } from "./workspacePath";
import { stopFromJsonlTurnEnded } from "../../hub/src/generationOwnership";
import type { HookMatch, PendingRun } from "./binding";

const TOLERANCE_MS = 5_000;
const CID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LEAF_RE = new RegExp(`/agent-transcripts/(${CID_RE})/\\1\\.jsonl$`, "i");
const SUB_RE = new RegExp(`/subagents/(${CID_RE})\\.jsonl$`, "i");
const QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;

export interface TranscriptFileView {
  path: string;
  mtimeMs: number;
  firstPrompt: string;
  conversationId: string;
}

/** Cursor `~/.cursor/projects/<slug>` for a workspace fsPath. */
export function cursorProjectSlug(workspaceRoot: string): string {
  const n = normalizeWorkspacePath(workspaceRoot);
  const m = /^([a-z]):\/(.*)$/.exec(n);
  if (m) return `${m[1]}-${m[2].replace(/\//g, "-")}`;
  return n.replace(/^\//, "").replace(/\//g, "-");
}

export function transcriptsDirForWorkspace(cursorHome: string, workspaceRoot: string): string | null {
  const slug = cursorProjectSlug(workspaceRoot);
  const projects = join(cursorHome, ".cursor", "projects");
  const exact = join(projects, slug, "agent-transcripts");
  if (existsSync(exact)) return exact;
  try {
    for (const name of readdirSync(projects)) {
      if (name.toLowerCase() !== slug.toLowerCase()) continue;
      const dir = join(projects, name, "agent-transcripts");
      if (existsSync(dir)) return dir;
    }
  } catch { /* missing projects dir */ }
  return null;
}

export function conversationIdFromTranscriptPath(path: string): string | null {
  const m = LEAF_RE.exec(path.replace(/\\/g, "/"));
  return m ? m[1] : null;
}

export function childCidFromSubagentPath(path: string): string | null {
  const m = SUB_RE.exec(path.replace(/\\/g, "/"));
  return m ? m[1] : null;
}

/** Parent jsonl `.../cid/cid.jsonl` → sibling `.../cid/subagents/<child>.jsonl`. */
export function listSubagentTranscripts(parentJsonl: string): string[] {
  const dir = join(dirname(parentJsonl), "subagents");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    const p = join(dir, name);
    if (childCidFromSubagentPath(p)) out.push(p);
  }
  return out;
}

function flattenUserText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const msg = (raw as { message?: { content?: unknown } }).message;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (typeof p === "string") parts.push(p);
    else if (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
      parts.push((p as { text: string }).text);
    }
  }
  return parts.join("");
}

export function extractFirstUserPrompt(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let j: { role?: unknown };
    try { j = JSON.parse(t); } catch { continue; }
    if (j.role !== "user") continue;
    const text = flattenUserText(j);
    if (!text) continue;
    const q = QUERY_RE.exec(text);
    const inner = q ? q[1]! : text;
    const stripped = stripImageMarkers(inner);
    if (stripped) return stripped;
    if (hasImageMarkers(inner)) return "";
    return normalizePrompt(inner);
  }
  return null;
}

export function listLeafTranscripts(transcriptsRoot: string): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(transcriptsRoot); } catch { return out; }
  for (const name of names) {
    const leaf = join(transcriptsRoot, name, `${name}.jsonl`);
    if (existsSync(leaf)) out.push(leaf);
  }
  return out;
}

/** Last complete jsonl line; 8KiB tail so Reload idle poll does not read the whole file. */
export function readLastNonEmptyLine(path: string): string {
  try {
    const st = statSync(path);
    if (st.size <= 0) return "";
    const n = Math.min(st.size, 8192);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, st.size - n);
      const lines = buf.toString("utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return lines[lines.length - 1] ?? "";
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export type TranscriptTail = { path: string; lastLine: string; mtimeMs: number };

/** Parent leaves plus sibling subagent jsonl, for Reload idle (open composer turns). */
export function collectTranscriptTails(transcriptsRoot: string): TranscriptTail[] {
  const out: TranscriptTail[] = [];
  for (const path of listLeafTranscripts(transcriptsRoot)) {
    pushTail(out, path);
    for (const sub of listSubagentTranscripts(path)) pushTail(out, sub);
  }
  return out;
}

function pushTail(out: TranscriptTail[], path: string): void {
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return; }
  out.push({ path, lastLine: readLastNonEmptyLine(path), mtimeMs });
}

export function collectTranscriptViews(transcriptsRoot: string): TranscriptFileView[] {
  const views: TranscriptFileView[] = [];
  for (const path of listLeafTranscripts(transcriptsRoot)) {
    const conversationId = conversationIdFromTranscriptPath(path);
    if (!conversationId) continue;
    let mtimeMs = 0;
    let head = "";
    try {
      mtimeMs = statSync(path).mtimeMs;
      head = readFileSync(path, { encoding: "utf8" }).slice(0, 16_384);
    } catch { continue; }
    const firstPrompt = extractFirstUserPrompt(head);
    if (firstPrompt === null) continue;
    views.push({ path, mtimeMs, firstPrompt, conversationId });
  }
  return views;
}

export function matchTranscriptToPending(
  pending: PendingRun[],
  files: TranscriptFileView[],
  opts?: { boundCids?: Set<string> },
): HookMatch | null {
  const bound = opts?.boundCids;
  const usable = files.filter((f) => !bound?.has(f.conversationId));
  const fileHits: { file: TranscriptFileView; runs: PendingRun[] }[] = [];
  for (const f of usable) {
    const runs = pending.filter((p) => {
      if (f.mtimeMs < p.dispatchedAt - TOLERANCE_MS) return false;
      const want = stripImageMarkers(p.prompt);
      if (want && want === f.firstPrompt) return true;
      if (!want && !f.firstPrompt && (p.attachmentIds?.length ?? 0) > 0) return true;
      return false;
    });
    if (runs.length > 0) fileHits.push({ file: f, runs });
  }
  const ambiguous = fileHits.filter((h) => h.runs.length > 1);
  if (ambiguous.length > 0) {
    const runs = new Map<string, PendingRun>();
    for (const h of ambiguous) for (const r of h.runs) runs.set(r.runId, r);
    return { ambiguous: true, runs: [...runs.values()] };
  }
  const unique = fileHits.filter((h) => h.runs.length === 1);
  if (unique.length === 0) return null;
  const byRun = new Map<string, TranscriptFileView[]>();
  for (const h of unique) {
    const id = h.runs[0]!.runId;
    const lst = byRun.get(id) ?? [];
    lst.push(h.file);
    byRun.set(id, lst);
  }
  for (const matched of byRun.values()) {
    if (matched.length > 1) {
      return { ambiguous: true, runs: unique.map((h) => h.runs[0]!) };
    }
  }
  const first = unique[0]!;
  return {
    run: first.runs[0]!,
    conversationId: first.file.conversationId,
    transcriptPath: first.file.path,
    promptMatch: true,
  };
}

/** Map a Cursor jsonl line to hub `onStopEvent` payload. Null = not a terminal line. */
export function stopPayloadFromTranscriptLine(line: string): { status: string; error?: string } | null {
  try { return stopFromJsonlTurnEnded(JSON.parse(line)); } catch { return null; }
}

/** Last complete jsonl record. Null if the turn is still open (user started another). */
export function stopFromTranscriptFileContent(content: string): { status: string; error?: string } | null {
  const lines = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return stopPayloadFromTranscriptLine(lines[lines.length - 1]!);
}

/** Prompt text from a hub/extension event payload (hook prompt or transcript user). */
export function userPromptFromEventPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { prompt?: unknown; role?: unknown };
  if (typeof p.prompt === "string" && p.prompt.trim()) return normalizePrompt(p.prompt);
  if (p.role === "user") return extractFirstUserPrompt(JSON.stringify(payload));
  return null;
}

/**
 * After followup/adopt, Windows may still see the previous turn_ended as the
 * file's last line. Suppress synthesized stop until a new user line arrives.
 */
export class FollowupStopGuard {
  private waitingUser = new Set<string>();

  arm(runId: string): void {
    this.waitingUser.add(runId);
  }

  onUser(runId: string): void {
    this.waitingUser.delete(runId);
  }

  shouldEmitStop(runId: string): boolean {
    return !this.waitingUser.has(runId);
  }
}

/**
 * How long after dispatch we keep scanning for the first jsonl so we can
 * bind the run.
 *
 * Hub bind clocks (`hub/src/runs.ts` sweepTimeouts). Cursor on Windows often
 * writes the first jsonl *after* CDP inject returns — observed 22s on a
 * busy window; attachment-heavy injects can sit in binding well past 60s.
 * A 20s/70s local window stopped scanning while the agent was still running.
 *
 * Keep this >= the slower hub clock (Windows) so we don't give up first.
 * Extra 10s past Windows BIND_TIMEOUT lets a late run.bound resurrect
 * (hub `onRunBound` treats BIND_TIMEOUT as recoverable).
 */
export const BIND_TIMEOUT_MS = 60_000;
export const WINDOWS_BIND_TIMEOUT_MS = 180_000;
export const TRANSCRIPT_BIND_WINDOW_MS = WINDOWS_BIND_TIMEOUT_MS + 10_000;

export function isWithinTranscriptBindWindow(
  dispatchedAt: number,
  now: number = Date.now(),
): boolean {
  return now - dispatchedAt <= TRANSCRIPT_BIND_WINDOW_MS;
}

export function transcriptJsonlPath(dir: string, conversationId: string): string {
  return join(dir, conversationId, `${conversationId}.jsonl`);
}

export type LateTranscriptAttach =
  | { action: "attach"; path: string; fromEnd: false }
  | { action: "skip" };

/** Hook bind often races the first jsonl create. Attach from start so turn_ended is not dropped. */
export function decideLateTranscriptAttach(input: {
  alreadyAttachedPath: string | undefined;
  candidatePath: string | null;
}): LateTranscriptAttach {
  if (input.alreadyAttachedPath) return { action: "skip" };
  if (!input.candidatePath) return { action: "skip" };
  return { action: "attach", path: input.candidatePath, fromEnd: false };
}
