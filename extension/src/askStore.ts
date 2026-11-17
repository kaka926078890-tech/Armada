import { homedir } from "os";
import { join } from "path";
import type { AskInspect, AskInspectOption, AskInspectQuestion } from "./askDetect";

/** Only the tail is an open question. A pending row outside the header list is a leftover, except a body flushed before the header is saved. */
export const ASK_STORE_TAIL = 40;
/** Cursor flushes the pending ask body with rootUnchanged, so the on-disk header list lags that row. */
export const ASK_RECENT_ROWS = 8;

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
  all: (...args: string[]) => { key?: unknown }[];
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

function recentBubbleIds(db: SqlDb, cid: string): string[] {
  const start = `bubbleId:${cid}:`;
  const end = `bubbleId:${cid};`;
  let rows: { key?: unknown }[] = [];
  try {
    rows = db.prepare(
      `SELECT key FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY rowid DESC LIMIT ${ASK_RECENT_ROWS}`,
    ).all(start, end);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const row of rows) {
    const key = typeof row.key === "string" ? row.key : "";
    if (!key.startsWith(start)) continue;
    const id = key.slice(start.length).trim();
    if (id) ids.push(id);
  }
  return ids;
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

/** null = the file could not be read. Do not treat that as "no question". */
export async function readStoredAsks(cids: string[], home = homedir(), platform = process.platform): Promise<DbAsk[] | null> {
  const unique = [...new Set(cids.map((c) => c.trim()).filter(Boolean))];
  if (!unique.length) return [];
  const path = cursorStateDbPath(home, platform);
  if (!path) return null;
  let db: SqlDb;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path, { readOnly: true }) as SqlDb;
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
