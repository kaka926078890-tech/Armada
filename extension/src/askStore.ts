import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Worker } from "node:worker_threads";
import type { AskInspect, AskInspectOption, AskInspectQuestion } from "./askDetect";

/** Only the tail is an open question. A pending row outside the header list is a leftover, except a body flushed before the header is saved. */
export const ASK_STORE_TAIL = 40;
/** Cursor flushes the pending ask body with rootUnchanged, so the on-disk header list lags that row. */
export const ASK_RECENT_ROWS = 8;
/**
 * Key range on the UNIQUE index. Do not `ORDER BY rowid` here: SQLite then builds a
 * temp b-tree of every bubble in the conversation. On a multi-gigabyte state.vscdb that
 * sort runs on the extension host and the 15s heartbeat misses the hub's 45s sweep.
 * Row order is applied in `newestBubbleIds` after the index range returns.
 */
export const RECENT_BUBBLE_SQL =
  "SELECT key, rowid AS rid FROM cursorDiskKV WHERE key >= ? AND key < ?";
/** A slow disk read must not pin the host thread. The next poll retries. */
const ASK_READ_TIMEOUT_MS = 1_500;

export type DbAsk =
  | { cid: string; state: "pending"; inspect: AskInspect }
  | { cid: string; state: "loading" }
  | { cid: string; state: "submitted" }
  | { cid: string; state: "none" };

export function cursorStateDbPath(home: string, platform: string): string | null {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "win32") {
    return join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return null;
}

export function headerBubbleIds(composer: unknown): string[] {
  if (!composer || typeof composer !== "object") return [];
  const headers = (composer as { fullConversationHeadersOnly?: unknown }).fullConversationHeadersOnly;
  if (!Array.isArray(headers)) return [];
  const ids: string[] = [];
  for (const h of headers) {
    const id = h && typeof h === "object" && typeof (h as { bubbleId?: unknown }).bubbleId === "string"
      ? (h as { bubbleId: string }).bubbleId.trim()
      : "";
    if (id) ids.push(id);
  }
  return ids;
}

export function tailBubbleIds(composer: unknown, limit = ASK_STORE_TAIL): string[] {
  return headerBubbleIds(composer).slice(-limit);
}

/** `newestFirst` is rowid order, newest at index 0. Ids already in the header list are not a new flush. */
export function extraBubbleIds(headerIds: readonly string[], newestFirst: readonly string[]): string[] {
  const known = new Set(headerIds);
  const fresh: string[] = [];
  for (const id of newestFirst) {
    const trimmed = id.trim();
    if (!trimmed || known.has(trimmed)) continue;
    known.add(trimmed);
    fresh.push(trimmed);
  }
  return fresh.reverse();
}

function letterAt(index: number): string {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : "";
}

function asObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? raw as Record<string, unknown> : null;
}

type AskClass = "pending" | "loading" | "submitted" | "skip";

function classifyBubble(bubble: unknown): AskClass {
  const o = asObject(bubble);
  const tf = asObject(o?.toolFormerData);
  if (!tf || tf.name !== "ask_question") return "skip";
  const ad = asObject(tf.additionalData);
  if (ad?.status === "pending") return "pending";
  if (ad?.status === "submitted") return "submitted";
  return "loading";
}

function questionsOf(tf: Record<string, unknown> | null): AskInspectQuestion[] {
  if (!tf) return [];
  const fromRaw = questionsFromArgs(tf.rawArgs);
  if (fromRaw.length) return fromRaw;
  return questionsFromArgs(tf.params);
}

function questionsFromArgs(rawArgs: unknown): AskInspectQuestion[] {
  const args = asObject(rawArgs);
  const list = Array.isArray(args?.questions) ? args.questions : [];
  const questions: AskInspectQuestion[] = [];
  for (let i = 0; i < list.length; i++) {
    const q = asObject(list[i]);
    if (!q) continue;
    const prompt = typeof q.prompt === "string" && q.prompt.trim() ? q.prompt.trim() : "";
    if (!prompt) continue;
    const opts: AskInspectOption[] = [];
    const rawOpts = Array.isArray(q.options) ? q.options : [];
    for (const item of rawOpts) {
      const o = asObject(item);
      const text = typeof o?.label === "string" && o.label.trim() ? o.label.trim() : "";
      const letter = letterAt(opts.length);
      if (!text || !letter) continue;
      opts.push({ id: letter.toLowerCase(), label: letter, text });
    }
    const free = letterAt(opts.length);
    if (free) opts.push({ id: free.toLowerCase(), label: free, text: "Other...", freeform: true });
    if (opts.length < 2) continue;
    questions.push({ id: `q${questions.length}`, prompt, options: opts });
  }
  return questions;
}

/** Bubbles are in header order. The latest ask_question decides. A question body is enough; the chat does not have to be focused. */
export function inspectStoredBubbles(cid: string, bubbles: unknown[]): DbAsk {
  let state: "pending" | "loading" | "submitted" | "none" = "none";
  let questions: AskInspectQuestion[] = [];
  for (const bubble of bubbles) {
    const kind = classifyBubble(bubble);
    if (kind === "skip") continue;
    if (kind === "submitted") {
      state = "submitted";
      questions = [];
      continue;
    }
    const parsed = questionsOf(asObject(asObject(bubble)?.toolFormerData));
    if (!parsed.length) {
      state = "loading";
      questions = [];
      continue;
    }
    state = "pending";
    questions = parsed;
  }
  if (state !== "pending" || !questions.length) return { cid, state: state === "pending" ? "loading" : state };
  const first = questions[0]!;
  return {
    cid,
    state: "pending",
    inspect: {
      present: true,
      prompt: first.prompt,
      conversation_id: cid,
      options: first.options,
      questions,
    },
  };
}

type SqlStmt = {
  get: (key: string) => { value?: unknown } | null;
  all: (...args: string[]) => { key?: unknown; rid?: unknown }[];
};

type SqlDb = {
  prepare: (sql: string) => SqlStmt;
  close: () => void;
};

function cellText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return null;
}

/**
 * The on-screen widget wins for its conversation.
 * A stored pending ask is added only for a different conversation.
 * submitted means the latest ask was answered. none means the tail has no ask, which is not "answered".
 */
export function mergeVisibleAndStoredAsks(cdp: AskInspect, stored: DbAsk[]): {
  presents: AskInspect[];
  submittedCids: string[];
  loadingCids: string[];
} {
  const presents: AskInspect[] = [];
  const covered = new Set<string>();
  if (!("unknown" in cdp) && cdp.present && cdp.options.length > 0) {
    presents.push(cdp);
    if (cdp.conversation_id) covered.add(cdp.conversation_id);
    else {
      const only = stored.filter((row) => row.state === "pending");
      if (only.length === 1 && only[0]) covered.add(only[0].cid);
    }
  }
  const submittedCids: string[] = [];
  const loadingCids: string[] = [];
  for (const row of stored) {
    if (row.state === "pending") {
      if (!covered.has(row.cid)) presents.push(row.inspect);
      covered.add(row.cid);
      continue;
    }
    if (row.state === "submitted") submittedCids.push(row.cid);
    if (row.state === "loading") loadingCids.push(row.cid);
  }
  return { presents, submittedCids, loadingCids };
}

/** Highest rowid first. Key sort is not insertion order: bubble ids are random UUIDs. */
export function newestBubbleIds(
  rows: readonly { key?: unknown; rid?: unknown }[],
  prefix: string,
  limit = ASK_RECENT_ROWS,
): string[] {
  const ranked: { id: string; rid: number }[] = [];
  for (const row of rows) {
    const key = typeof row.key === "string" ? row.key : "";
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length).trim();
    const rid = typeof row.rid === "number" ? row.rid
      : typeof row.rid === "bigint" ? Number(row.rid)
      : NaN;
    if (!id || !Number.isFinite(rid)) continue;
    ranked.push({ id, rid });
  }
  ranked.sort((a, b) => b.rid - a.rid);
  return ranked.slice(0, limit).map((row) => row.id);
}

function recentBubbleIds(db: SqlDb, cid: string): string[] {
  const start = `bubbleId:${cid}:`;
  const end = `bubbleId:${cid};`;
  let rows: { key?: unknown; rid?: unknown }[] = [];
  try {
    rows = db.prepare(RECENT_BUBBLE_SQL).all(start, end);
  } catch {
    return [];
  }
  return newestBubbleIds(rows, start);
}

function bubbleMap(db: SqlDb, cid: string, ids: readonly string[]): Map<string, string> {
  const get = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  const out = new Map<string, string>();
  for (const id of ids) {
    if (out.has(id)) continue;
    const raw = cellText(get.get(`bubbleId:${cid}:${id}`)?.value);
    if (raw) out.set(id, raw);
  }
  return out;
}

/** Header tail, then bubble rows flushed before the header list was saved. Newest of those rows is last. */
export function asksFromComposerRows(
  cid: string,
  composerRaw: string | null,
  bubblesById: ReadonlyMap<string, string>,
  newestFirst: readonly string[],
): DbAsk {
  let composer: unknown = null;
  if (composerRaw) {
    try { composer = JSON.parse(composerRaw); } catch { return { cid, state: "loading" }; }
  }
  const headerIds = headerBubbleIds(composer);
  const ids = [...tailBubbleIds(composer), ...extraBubbleIds(headerIds, newestFirst)];
  if (!ids.length) return { cid, state: "none" };
  const bubbles: unknown[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const raw = bubblesById.get(id);
    if (!raw) continue;
    try { bubbles.push(JSON.parse(raw)); } catch { /* skip one bad row */ }
  }
  return inspectStoredBubbles(cid, bubbles);
}

/** null = the file could not be read. Do not treat that as "no question". Runs in the ask worker. */
export async function readStoredAsksSync(cids: string[], home = homedir(), platform = process.platform): Promise<DbAsk[] | null> {
  const unique = [...new Set(cids.map((c) => c.trim()).filter(Boolean))];
  if (!unique.length) return [];
  const path = cursorStateDbPath(home, platform);
  if (!path) return null;
  let db: SqlDb;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path, { readOnly: true, timeout: 300 }) as SqlDb;
  } catch {
    return null;
  }
  try {
    const get = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    const out: DbAsk[] = [];
    for (const cid of unique) {
      const composerRaw = cellText(get.get(`composerData:${cid}`)?.value);
      const newestFirst = recentBubbleIds(db, cid);
      let composer: unknown = null;
      if (composerRaw) {
        try { composer = JSON.parse(composerRaw); } catch { out.push({ cid, state: "loading" }); continue; }
      }
      const ids = [
        ...tailBubbleIds(composer),
        ...extraBubbleIds(headerBubbleIds(composer), newestFirst),
      ];
      out.push(asksFromComposerRows(cid, composerRaw, bubbleMap(db, cid, ids), newestFirst));
    }
    return out;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

type AskWorkerMsg = { id?: number; asks?: DbAsk[] | null };
let askWorker: Worker | null = null;
let askInflight = false;
let askSeq = 0;
const askWaiters = new Map<number, (asks: DbAsk[] | null) => void>();

function askWorkerFile(): string {
  return join(__dirname, "askReadWorker.js");
}

function askReader(): Worker | null {
  if (!existsSync(askWorkerFile())) return null;
  if (askWorker) return askWorker;
  const child = new Worker(askWorkerFile());
  child.on("message", (msg: AskWorkerMsg) => {
    const done = askWaiters.get(msg.id ?? -1);
    if (!done) return;
    askWaiters.delete(msg.id ?? -1);
    done(msg.asks ?? null);
  });
  const fail = () => {
    askInflight = false;
    for (const done of askWaiters.values()) done(null);
    askWaiters.clear();
    askWorker = null;
  };
  child.on("error", fail);
  child.on("exit", fail);
  askWorker = child;
  return child;
}

/** Drop the ask worker when the extension deactivates. */
export function closeAskReader(): void {
  const child = askWorker;
  askWorker = null;
  askInflight = false;
  for (const done of askWaiters.values()) done(null);
  askWaiters.clear();
  void child?.terminate();
}

/**
 * Ask rows are read off the extension host thread. The host keeps sending heartbeats
 * while state.vscdb is scanned. A read still running returns null; the next poll retries.
 */
export function readStoredAsks(cids: string[], home = homedir(), platform = process.platform): Promise<DbAsk[] | null> {
  const child = askReader();
  if (!child) return readStoredAsksSync(cids, home, platform);
  if (askInflight) return Promise.resolve(null);
  askInflight = true;
  const id = ++askSeq;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ASK_READ_TIMEOUT_MS);
    askWaiters.set(id, (asks) => {
      clearTimeout(timer);
      askInflight = false;
      if (!settled) {
        settled = true;
        resolve(asks);
      }
    });
    child.postMessage({ id, cids, home, platform });
  });
}
