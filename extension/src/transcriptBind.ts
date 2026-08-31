import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { normalizePrompt } from "./promptNormalize";
import { normalizeWorkspacePath } from "./workspacePath";
import type { HookMatch, PendingRun } from "./binding";

const TOLERANCE_MS = 5_000;
const CID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LEAF_RE = new RegExp(`/agent-transcripts/(${CID_RE})/\\1\\.jsonl$`, "i");
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
    return normalizePrompt(q ? q[1]! : text);
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
    if (!firstPrompt) continue;
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
    const runs = pending.filter((p) =>
      normalizePrompt(p.prompt) === f.firstPrompt
      && f.mtimeMs >= p.dispatchedAt - TOLERANCE_MS,
    );
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
  let j: { type?: unknown; status?: unknown; error?: unknown };
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type !== "turn_ended") return null;
  const s = typeof j.status === "string" ? j.status : "";
  if (s === "aborted" || s === "cancelled" || s === "canceled") return { status: "aborted" };
  if (s === "error") return { status: "error", error: typeof j.error === "string" ? j.error : "error" };
  return { status: "completed" };
}

export const TRANSCRIPT_BIND_WINDOW_MS = 20_000;
