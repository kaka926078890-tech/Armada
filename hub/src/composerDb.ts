import { hasImageMarkers, stripImageMarkers } from "../../extension/src/imageMarkers";
import { stripLeadingInboxMentions, TRANSCRIPT_BIND_WINDOW_MS } from "../../extension/src/transcriptBind";
import { workspacePathsEqual } from "../../extension/src/workspacePath";
import { CHATGPT_LOCAL_MACHINE, sameHost } from "./chatgptAttach";
import { operatorAlertPrompt } from "./outboundClaim";

/** Header createdAt may land a few milliseconds around dispatch. */
export const HEADER_CREATED_SKEW_MS = 5_000;
/** createNew's header is the row written in this window. Same clock as the Windows bind timeout. */
const COMPOSER_CREATE_WINDOW_MS = 180_000;

export type HeaderCandidate = {
  composerId: string;
  createdAt: number;
  isSubagent: boolean;
  workspacePath: string;
  firstUserText: string | null;
};

export type ComposerBubble = {
  id: string;
  type: number;
  text: string;
  thinking: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  toolStatus: string;
  subagentComposerId: string;
  /** User bubble `requestId`. This is the turn's generation, not `chatGenerationUUID`. */
  requestId: string;
  /** User bubble `startedAtMs`. Used to pick the dispatch turn when a later follow-up sorts first. */
  startedAtMs?: number;
  /** Set on the step row that closes the turn. Absent while the reply is still being written. */
  turnDurationMs?: number;
};

export type ComposerView = {
  cid: string;
  status: string;
  generationId: string | null;
  subagentIds: string[];
  bubbles: ComposerBubble[];
};

export type DbEvent = {
  source: "db" | "subagent-transcript";
  hook: string | null;
  conversationId: string;
  payload: Record<string, unknown>;
};

export type ChildCursor = { texts: string[]; closed: boolean };

export type ComposerCursor = {
  users: string[];
  thoughts: string[];
  tools: string[];
  assistants: string[];
  /** Last afterAgentResponse text for a bubble. A longer prefix is emitted again. */
  assistantText: Record<string, string>;
  generationId: string | null;
  /** Generation id last placed on a beforeSubmitPrompt. */
  armedGen: string | null;
  sawGeneration: boolean;
  /** UUID already cleared once while status was still aborted. */
  abortSeen: boolean;
  stopped: boolean;
  /** Set when an idle composer has been fully emitted. Skips per-bubble reads. */
  idleKey: string;
  children: Record<string, ChildCursor>;
};

export function emptyCursor(): ComposerCursor {
  return {
    users: [], thoughts: [], tools: [], assistants: [], assistantText: {},
    generationId: null, armedGen: null, sawGeneration: false, abortSeen: false, stopped: false,
    idleKey: "", children: {},
  };
}

export function promptsMatch(runPrompt: string, bubble: string, attachmentCount = 0): boolean {
  // Cursor writes an attached file as `@.armada/inbox/<run>/<file> ` in front of the prompt.
  // jsonl bind already strips that; the composer table must use the same text.
  const a = stripLeadingInboxMentions(stripImageMarkers(bubble));
  const b = stripLeadingInboxMentions(stripImageMarkers(runPrompt ?? ""));
  if (a && a === b) return true;
  if (!a && attachmentCount > 0 && (hasImageMarkers(bubble) || !b)) return true;
  return false;
}

/** Retry resets started_at. The header window follows that dispatch, not the original created_at. */
export function composerBindAnchor(run: { created_at: number; started_at?: number | null }): number {
  return run.started_at ?? run.created_at;
}

/** One connected machine on this host. Two matches is not a guess. */
export function pickLocalMachineId(
  rows: { id: string; name: string }[],
  host: string,
  connected: (id: string) => boolean,
): string | null {
  const hits = rows.filter((r) => r.id !== CHATGPT_LOCAL_MACHINE && sameHost(r.name, host) && connected(r.id));
  return hits.length === 1 ? hits[0]!.id : null;
}

/** Hub host reads Cursor's composer table. Remote machines stay on hooks and jsonl. */
export function usesComposerDb(machineId: string, localId: string | null): boolean {
  return localId != null && machineId === localId;
}

/**
 * Windows jsonl never lists the user row in `fullConversationHeadersOnly`.
 * The header `createNew` writes is the one whose `createdAt` is first after
 * inject. Prompt text lives in `bubbleId:` rows, so it cannot be the key.
 */
export function matchComposerByCreatedAt(
  headers: HeaderCandidate[],
  run: { workspaceRoot: string; createdAt: number },
  bound: Set<string>,
): string | null {
  const from = run.createdAt - 1_000;
  const until = run.createdAt + COMPOSER_CREATE_WINDOW_MS;
  const hits = headers.filter((h) =>
    !h.isSubagent
    && !bound.has(h.composerId)
    && h.createdAt >= from
    && h.createdAt <= until
    && h.workspacePath
    && workspacePathsEqual(h.workspacePath, run.workspaceRoot)
  );
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.createdAt - b.createdAt || a.composerId.localeCompare(b.composerId));
  return hits[0]!.composerId;
}

export function matchComposer(
  headers: HeaderCandidate[],
  run: { prompt: string; workspaceRoot: string; createdAt: number; attachmentCount?: number },
  bound: Set<string>,
): string | null {
  const hits = headers.filter((h) =>
    !h.isSubagent
    && !bound.has(h.composerId)
    && h.createdAt >= run.createdAt - HEADER_CREATED_SKEW_MS
    && h.workspacePath
    && workspacePathsEqual(h.workspacePath, run.workspaceRoot)
    && h.firstUserText != null
    && promptsMatch(run.prompt, h.firstUserText, run.attachmentCount ?? 0),
  );
  return hits.length === 1 ? hits[0]!.composerId : null;
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

function asRecord(raw: unknown): Record<string, unknown> | null {
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

function thinkingText(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  const o = asRecord(raw);
  return typeof o?.text === "string" ? o.text.trim() : "";
}

function toolInput(raw: unknown): Record<string, unknown> | undefined {
  const o = asRecord(raw);
  return o ?? undefined;
}

export function workspacePathFromHeader(value: unknown): string {
  const o = asRecord(value);
  const ident = asRecord(o?.workspaceIdentifier);
  const uri = asRecord(ident?.uri);
  return typeof uri?.fsPath === "string" ? uri.fsPath : "";
}

function parseBubble(id: string, raw: unknown): ComposerBubble {
  const o = asRecord(raw) ?? {};
  const tf = asRecord(o.toolFormerData) ?? {};
  const ad = asRecord(tf.additionalData) ?? {};
  return {
    id,
    type: typeof o.type === "number" ? o.type : 0,
    text: typeof o.text === "string" ? o.text : "",
    thinking: thinkingText(o.thinking),
    toolName: typeof tf.name === "string" ? tf.name : "",
    toolInput: toolInput(tf.rawArgs),
    toolStatus: typeof tf.status === "string" ? tf.status : (typeof ad.status === "string" ? ad.status : ""),
    subagentComposerId: typeof ad.subagentComposerId === "string" ? ad.subagentComposerId : "",
    requestId: typeof o.requestId === "string" ? o.requestId.trim() : "",
    startedAtMs: typeof o.startedAtMs === "number" && o.startedAtMs > 0 ? o.startedAtMs : undefined,
    turnDurationMs: typeof o.turnDurationMs === "number" && o.turnDurationMs > 0 ? o.turnDurationMs : undefined,
  };
}

/** Dispatch prompt is the earliest user bubble. A later follow-up can sort first by bubble id. */
export function dispatchUserText(bubbles: ComposerBubble[]): string | null {
  const users = bubbles.filter((b) => b.type === 1 && b.text.trim());
  if (users.length === 0) return null;
  const timed = users.filter((b) => typeof b.startedAtMs === "number");
  if (timed.length !== users.length) return users[0]!.text;
  timed.sort((a, b) => a.startedAtMs! - b.startedAtMs! || a.id.localeCompare(b.id));
  return timed[0]!.text;
}

export function parseComposer(cid: string, raw: unknown, bubbles: ComposerBubble[]): ComposerView | null {
  const o = asRecord(raw);
  if (!o) return null;
  const ids = Array.isArray(o.subagentComposerIds)
    ? o.subagentComposerIds.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  const gen = typeof o.chatGenerationUUID === "string" && o.chatGenerationUUID.trim() ? o.chatGenerationUUID.trim() : null;
  return {
    cid,
    status: typeof o.status === "string" ? o.status : "",
    generationId: gen,
    subagentIds: ids,
    bubbles,
  };
}

type Kv = { query(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown } };

export function readHeaderCandidates(db: Kv, sinceMs: number): HeaderCandidate[] {
  const rows = db.query(
    "SELECT composerId, createdAt, isSubagent, value FROM composerHeaders WHERE createdAt >= ?1",
  ).all(sinceMs) as { composerId: string; createdAt: number; isSubagent: number | null; value: unknown }[];
  const out: HeaderCandidate[] = [];
  for (const row of rows) {
    if (!row.composerId || row.isSubagent === 1) continue;
    const view = readComposerView(db, row.composerId);
    out.push({
      composerId: row.composerId,
      createdAt: Number(row.createdAt) || 0,
      isSubagent: false,
      workspacePath: workspacePathFromHeader(cellText(row.value) || row.value),
      firstUserText: view ? dispatchUserText(view.bubbles) : null,
    });
  }
  return out;
}

function bubbleRest(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : "";
}

/** First `/` or `\` in a bubble key suffix. Tool calls use `t:call-` or `t:toolu_`; Windows text uses `s:<n>`. */
function bubbleSplit(rest: string): { parent: string; tail: string } | null {
  const slash = rest.indexOf("/");
  const back = rest.indexOf("\\");
  const cut = slash < 0 ? back : back < 0 ? slash : Math.min(slash, back);
  if (cut <= 0) return null;
  return { parent: rest.slice(0, cut), tail: rest.slice(cut + 1) };
}

/** Composer rows are `t:call-`. Claude rows are `t:toolu_` / `t:toolu_bdrk_`. Nested fragments are a second split, not this tail. */
function isToolCallTail(tail: string): boolean {
  return tail.startsWith("t:") && !tail.includes("/") && !tail.includes("\\");
}

/**
 * Header list empty: parent rows, then that parent's `/s:<n>` steps in numeric
 * order, then its `/t:` tool rows. Nested `fc_` fragments stay out.
 */
function fallbackBubbleIds(db: Kv, cid: string): string[] {
  // `LIKE 'prefix%'` cannot bound this UNIQUE index (LIKE is case-insensitive), so it
  // scans every key in cursorDiskKV. On a multi-gigabyte state.vscdb that scan blocks
  // the hub thread, and hide/list wait behind it. `:` + 1 = `;` is the exclusive end.
  const start = `bubbleId:${cid}:`;
  const end = `bubbleId:${cid};`;
  let rows: { key?: unknown }[] = [];
  try {
    rows = db.query("SELECT key FROM cursorDiskKV WHERE key >= ?1 AND key < ?2").all(start, end) as { key?: unknown }[];
  } catch {
    return [];
  }
  const prefix = start;
  const parents: string[] = [];
  const steps = new Map<string, { n: number; id: string }[]>();
  const tools = new Map<string, string[]>();
  for (const row of rows) {
    const key = typeof row.key === "string" ? row.key : "";
    const rest = bubbleRest(key, prefix);
    if (!rest) continue;
    const split = bubbleSplit(rest);
    if (!split) {
      parents.push(rest);
      continue;
    }
    const step = /^s:(\d+)$/.exec(split.tail);
    if (step) {
      const list = steps.get(split.parent) ?? [];
      list.push({ n: Number(step[1]), id: rest });
      steps.set(split.parent, list);
      continue;
    }
    if (isToolCallTail(split.tail)) {
      const list = tools.get(split.parent) ?? [];
      list.push(rest);
      tools.set(split.parent, list);
    }
  }
  const seen = new Set(parents);
  const ordered = [...parents];
  for (const parent of steps.keys()) if (!seen.has(parent)) ordered.push(parent);
  for (const parent of tools.keys()) if (!seen.has(parent) && !ordered.includes(parent)) ordered.push(parent);
  const out: string[] = [];
  for (const parent of ordered) {
    if (seen.has(parent)) out.push(parent);
    const list = steps.get(parent);
    if (list) {
      list.sort((a, b) => a.n - b.n || a.id.localeCompare(b.id));
      for (const step of list) out.push(step.id);
    }
    const calls = tools.get(parent);
    if (calls) {
      calls.sort((a, b) => a.localeCompare(b));
      for (const id of calls) out.push(id);
    }
  }
  return out;
}

function loadBubble(db: Kv, cid: string, id: string): { bubble: ComposerBubble; createdAt: number | null } | null {
  const bubbleCell = db.query("SELECT value FROM cursorDiskKV WHERE key=?1").get(`bubbleId:${cid}:${id}`) as { value?: unknown } | null;
  const text = cellText(bubbleCell?.value);
  if (!text) return null;
  try {
    const raw = JSON.parse(text);
    const at = asRecord(raw)?.createdAt;
    const ms = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN;
    return { bubble: parseBubble(id, raw), createdAt: Number.isFinite(ms) ? ms : null };
  } catch { return null; }
}

/**
 * Fallback ids come out in key order, which is uuid order. r-ac71f2e4: the 14:07
 * user sorted after every later turn, so it stayed the open turn and stop never fired.
 * Turns follow the parent row's createdAt; a group without one keeps its slot.
 */
function orderTurnsByCreatedAt(rows: { bubble: ComposerBubble; createdAt: number | null }[]): ComposerBubble[] {
  const groups: { parent: string; at: number | null; rows: ComposerBubble[] }[] = [];
  const byParent = new Map<string, (typeof groups)[number]>();
  for (const row of rows) {
    const parent = bubbleSplit(row.bubble.id)?.parent ?? row.bubble.id;
    let g = byParent.get(parent);
    if (!g) {
      g = { parent, at: null, rows: [] };
      byParent.set(parent, g);
      groups.push(g);
    }
    if (row.bubble.id === parent && row.createdAt != null) g.at = row.createdAt;
    else if (g.at == null && g.rows.length === 0 && row.createdAt != null) g.at = row.createdAt;
    g.rows.push(row.bubble);
  }
  let carry = -Infinity;
  const keyed = groups.map((g, i) => {
    if (g.at != null) carry = g.at;
    return { g, at: carry, i };
  });
  keyed.sort((a, b) => a.at - b.at || a.i - b.i);
  return keyed.flatMap((k) => k.g.rows);
}

/** Empty-header child row. Tool rows that already contain text stay out: noteBubble would emit them as a reply. */
function fallbackChild(id: string, bubble: ComposerBubble): ComposerBubble | null {
  const split = bubbleSplit(id);
  if (!split) return bubble;
  if (/^s:\d+$/.test(split.tail)) {
    const text = bubble.text.trim();
    if (text && bubble.toolName) return null;
    if (!text && !bubble.thinking) return null;
    if (text && !bubble.toolName && bubble.type !== 2) return { ...bubble, type: 2 };
    return bubble;
  }
  if (isToolCallTail(split.tail)) {
    if (bubble.text.trim() || !bubble.toolName) return null;
    return bubble;
  }
  return null;
}

export function readComposerView(db: Kv, cid: string): ComposerView | null {
  const cell = db.query("SELECT value FROM cursorDiskKV WHERE key=?1").get(`composerData:${cid}`) as { value?: unknown } | null;
  const raw = cellText(cell?.value);
  if (!raw) return null;
  let composer: unknown;
  try { composer = JSON.parse(raw); } catch { return null; }
  const headers = asRecord(composer)?.fullConversationHeadersOnly;
  const ids: string[] = [];
  if (Array.isArray(headers)) {
    for (const h of headers) {
      const id = asRecord(h)?.bubbleId;
      if (typeof id === "string" && id) ids.push(id);
    }
  }
  // PF39WTSM 2026-11-11: the header list stays empty while bubbleId rows hold the turn.
  const fromHeaders = ids.length > 0;
  const bubbleIds = fromHeaders ? ids : fallbackBubbleIds(db, cid);
  const rows: { bubble: ComposerBubble; createdAt: number | null }[] = [];
  for (const id of bubbleIds) {
    const loaded = loadBubble(db, cid, id);
    if (!loaded) continue;
    if (!fromHeaders && bubbleSplit(id)) {
      const child = fallbackChild(id, loaded.bubble);
      if (!child) continue;
      rows.push({ bubble: child, createdAt: loaded.createdAt });
      continue;
    }
    rows.push(loaded);
  }
  const bubbles = fromHeaders ? rows.map((r) => r.bubble) : orderTurnsByCreatedAt(rows);
  return parseComposer(cid, composer, bubbles);
}

function childOf(cursor: ComposerCursor, cid: string): ChildCursor {
  return cursor.children[cid] ?? { texts: [], closed: false };
}

function doneStatus(status: string): boolean {
  return status === "completed" || status === "success";
}

function requestIdBefore(bubbles: ComposerBubble[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const b = bubbles[i];
    const id = b?.type === 1 ? b.requestId.trim() : "";
    if (id) return id;
  }
  return null;
}

function lastUserIndex(bubbles: ComposerBubble[]): number {
  let last = -1;
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    if (b?.type === 1 && b.text.trim()) last = i;
  }
  return last;
}

/** The user turn that contains this bubble. `chatGenerationUUID` belongs only to the open turn. */
function generationOwning(bubbles: ComposerBubble[], index: number, openGen: string | null): string | null {
  const last = lastUserIndex(bubbles);
  let gen: string | null = null;
  let open = false;
  for (let i = 0; i <= index; i++) {
    const b = bubbles[i];
    if (b?.type === 1 && b.text.trim()) {
      gen = b.requestId || null;
      open = i === last;
    }
  }
  if (gen) return gen;
  return open ? openGen : null;
}

function bubbleIsBody(b: ComposerBubble): boolean {
  return !!(b.thinking || b.toolName || (b.type === 2 && b.text.trim()));
}

/** Body the feed already emitted on an earlier tick. A later bubble order must not count it again. */
function bodyAlreadyEmitted(b: ComposerBubble, cursor: ComposerCursor): boolean {
  if (!bubbleIsBody(b)) return false;
  if (b.thinking && !cursor.thoughts.includes(`${b.id}\0${b.thinking}`)) return false;
  if (b.toolName && !cursor.tools.includes(b.id)) return false;
  if (b.type === 2 && b.text.trim() && !b.toolName && !cursor.assistants.includes(b.id)) return false;
  return true;
}

/** Bubbles after the user that owns `gen`, and before the next user. */
function turnSlice(bubbles: ComposerBubble[], gen: string | null): { owner: number; slice: ComposerBubble[] } {
  let owner = -1;
  if (gen) {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (b?.type === 1 && b.text.trim() && b.requestId === gen) {
        owner = i;
        break;
      }
    }
  }
  if (owner < 0) owner = lastUserIndex(bubbles);
  if (owner < 0) return { owner: -1, slice: bubbles };
  let end = bubbles.length;
  for (let i = owner + 1; i < bubbles.length; i++) {
    const b = bubbles[i];
    if (b?.type === 1 && b.text.trim()) {
      end = i;
      break;
    }
  }
  return { owner, slice: bubbles.slice(owner + 1, end) };
}

function textTurnSettled(b: ComposerBubble): boolean {
  return b.type === 2 && !!b.text.trim() && !b.toolName && (b.turnDurationMs ?? 0) > 0;
}

/** `/s:<n>` belongs to its parent bubble. A step of another parent is not this turn. */
function stepParent(id: string): string | null {
  const split = bubbleSplit(id);
  if (!split || !/^s:\d+$/.test(split.tail)) return null;
  return split.parent;
}

function toolStillRunning(b: ComposerBubble): boolean {
  return !!b.toolName && b.toolStatus !== "completed" && b.toolStatus !== "error";
}

/**
 * r-4900ac33: the reply step carries `turnDurationMs` while `chatGenerationUUID` stays
 * set, so the uuid-cleared stop never runs and the card keeps spinning. A swap onto
 * another generation must not treat the previous turn's duration as this turn finishing.
 */
function settledOpenTurn(snap: ComposerView, gen: string | null): { ok: boolean; owner: number; slice: ComposerBubble[] } {
  const owned = turnSlice(snap.bubbles, gen);
  const user = owned.owner >= 0 ? snap.bubbles[owned.owner] : undefined;
  if (gen && user?.requestId && user.requestId !== gen) return { ok: false, owner: owned.owner, slice: owned.slice };
  if (owned.slice.some(toolStillRunning)) return { ok: false, owner: owned.owner, slice: owned.slice };
  const userId = user?.id ?? "";
  // r-7a755f88: an older /s:n with turnDurationMs sorts after the new user when
  // the header list is empty. That duration belongs to its own parent.
  const settles = owned.slice.some((b) => {
    if (!textTurnSettled(b)) return false;
    const parent = stepParent(b.id);
    return !parent || parent === userId;
  });
  return { ok: settles, owner: owned.owner, slice: owned.slice };
}

/** This user's own `/s:n` has finished. A parentless duration can belong to the previous turn. */
function ownStepSettled(snap: ComposerView, req: string): { ok: true; owner: number; slice: ComposerBubble[] } | null {
  if (!req) return null;
  const byRequest = settledOpenTurn(snap, req);
  if (!byRequest.ok) return null;
  const userId = snap.bubbles[byRequest.owner]?.id ?? "";
  const own = byRequest.slice.some((b) => textTurnSettled(b) && stepParent(b.id) === userId);
  return own ? { ok: true, owner: byRequest.owner, slice: byRequest.slice } : null;
}

function bsp(snap: ComposerView, bubble: ComposerBubble, generationId?: string | null): DbEvent {
  const gen = generationId === undefined ? snap.generationId : generationId;
  return {
    source: "db",
    hook: "beforeSubmitPrompt",
    conversationId: snap.cid,
    payload: {
      prompt: bubble.text,
      conversation_id: snap.cid,
      bubble_id: bubble.id,
      ...(gen ? { generation_id: gen } : {}),
    },
  };
}

type UnseenGroup = { start: number; end: number; gen: string | null };

/** Unseen user bubbles, grouped when they share a requestId (one generation). */
function unseenTurnGroups(bubbles: ComposerBubble[], seenUsers: string[]): UnseenGroup[] {
  const idxs: number[] = [];
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    if (b?.type === 1 && b.text.trim() && !seenUsers.includes(b.id)) idxs.push(i);
  }
  const groups: UnseenGroup[] = [];
  for (let n = 0; n < idxs.length; n++) {
    const i = idxs[n]!;
    const gen = bubbles[i]!.requestId.trim() || null;
    const end = n + 1 < idxs.length ? idxs[n + 1]! : bubbles.length;
    const prev = groups[groups.length - 1];
    if (prev && gen && prev.gen === gen) {
      prev.end = end;
      continue;
    }
    groups.push({ start: i, end, gen });
  }
  return groups;
}

/** Terminal cards stay on the table feed so a Cursor-typed turn can reopen them. */
export function composerFeedWatches(run: {
  status: string;
  conversation_id: string | null;
  end_reason?: string | null;
  created_at?: number | null;
  started_at?: number | null;
}, now = Date.now()): boolean {
  if (run.status === "dispatched" || run.status === "binding" || run.status === "running") return true;
  if (run.end_reason === "OPERATOR_CLOSED") return false;
  if (run.status === "unknown" && run.end_reason === "BIND_TIMEOUT" && !run.conversation_id?.trim()) {
    const anchor = run.started_at ?? run.created_at;
    return typeof anchor === "number" && now - anchor < TRANSCRIPT_BIND_WINDOW_MS;
  }
  if (!run.conversation_id?.trim()) return false;
  return run.status === "completed" || run.status === "error" || run.status === "aborted" || run.status === "cancelled";
}

export function composerIdleKey(status: string, generationId: string | null, bubbleIds: readonly string[]): string {
  return `${status}\n${generationId ?? ""}\n${bubbleIds.join("\n")}`;
}

export function readComposerHead(db: Kv, cid: string): { generationId: string | null; idleKey: string } | null {
  const cell = db.query("SELECT value FROM cursorDiskKV WHERE key=?1").get(`composerData:${cid}`) as { value?: unknown } | null;
  const raw = cellText(cell?.value);
  if (!raw) return null;
  let composer: unknown;
  try { composer = JSON.parse(raw); } catch { return null; }
  const o = asRecord(composer);
  if (!o) return null;
  const gen = typeof o.chatGenerationUUID === "string" && o.chatGenerationUUID.trim() ? o.chatGenerationUUID.trim() : null;
  const status = typeof o.status === "string" ? o.status : "";
  const ids: string[] = [];
  if (Array.isArray(o.fullConversationHeadersOnly)) {
    for (const h of o.fullConversationHeadersOnly) {
      const id = asRecord(h)?.bubbleId;
      if (typeof id === "string" && id) ids.push(id);
    }
  }
  return { generationId: gen, idleKey: composerIdleKey(status, gen, ids) };
}

/**
 * r-ac71f2e4: a blocked subagent keeps chatGenerationUUID and status "none" forever.
 * The parent tool row is already error or completed, so that leftover uuid is not work.
 */
function childReleaseStatus(parent: ComposerView, cid: string): "error" | "success" | null {
  const tool = parent.bubbles.find((b) =>
    b.subagentComposerId === cid && (b.toolStatus === "completed" || b.toolStatus === "error"));
  if (!tool) return null;
  return tool.toolStatus === "error" ? "error" : "success";
}

function childStillBusy(parent: ComposerView, children: ComposerView[], cursor: ComposerCursor): boolean {
  for (const child of children) {
    const cur = childOf(cursor, child.cid);
    const released = childReleaseStatus(parent, child.cid) != null;
    if (child.generationId && !released) return true;
    const sawWork = cur.texts.length > 0 || !!child.generationId;
    const closing = !cur.closed && (
      released
      || (!child.generationId && (
        doneStatus(child.status) || (sawWork && (child.status === "aborted" || child.status === "error"))
      ))
    );
    if (closing) continue;
    if (!cur.closed && !doneStatus(child.status)) return true;
  }
  return false;
}

/** Events the hub already understands. Busy is chatGenerationUUID, not composer status. */
export function planComposerTick(
  snap: ComposerView,
  children: ComposerView[],
  cursor: ComposerCursor,
): { events: DbEvent[]; cursor: ComposerCursor } {
  const next = structuredClone(cursor);
  const events: DbEvent[] = [];
  const emit = (ev: DbEvent) => events.push(ev);
  const flushedNow = new Set<string>();
  // Shell-finished / protocol bubbles are the same turn. Stopping on them
  // marks the card completed and the desktop banners while tools are still running.
  let heldForContinuation = false;
  const flushText = (b: ComposerBubble, gen: string | null): boolean => {
    const text = b.text.trim();
    if (b.type !== 2 || !text || b.toolName) return false;
    const prev = next.assistantText[b.id];
    if (prev === text) return false;
    // r-af47f349 s:29: the first snapshot ended at "0.4." and the same step
    // later grew. A different string is not this bubble filling in.
    if (prev && !(text.startsWith(prev) && text.length > prev.length)) return false;
    if (!prev && next.assistants.includes(b.id)) {
      next.assistantText[b.id] = text;
      return false;
    }
    next.assistantText[b.id] = text;
    if (!next.assistants.includes(b.id)) next.assistants.push(b.id);
    flushedNow.add(b.id);
    emit({
      source: "db",
      hook: "afterAgentResponse",
      conversationId: snap.cid,
      payload: {
        text,
        conversation_id: snap.cid,
        bubble_id: b.id,
        ...(gen ? { generation_id: gen } : {}),
      },
    });
    return true;
  };
  const noteBubble = (b: ComposerBubble, gen: string | null) => {
    if (b.thinking) {
      const key = `${b.id}\0${b.thinking}`;
      if (!next.thoughts.includes(key)) {
        next.thoughts.push(key);
        emit({
          source: "db",
          hook: "afterAgentThought",
          conversationId: snap.cid,
          payload: { text: b.thinking, conversation_id: snap.cid, bubble_id: b.id, ...(gen ? { generation_id: gen } : {}) },
        });
      }
    }
    if (b.toolName && !next.tools.includes(b.id)) {
      next.tools.push(b.id);
      emit({
        source: "db",
        hook: "preToolUse",
        conversationId: snap.cid,
        payload: {
          tool_name: b.toolName,
          tool_input: b.toolInput,
          conversation_id: snap.cid,
          bubble_id: b.id,
          ...(gen ? { generation_id: gen } : {}),
        },
      });
    }
    if (b.subagentComposerId && !next.children[b.subagentComposerId]) {
      const desc = typeof b.toolInput?.description === "string" ? b.toolInput.description
        : typeof b.toolInput?.prompt === "string" ? b.toolInput.prompt : "";
      next.children[b.subagentComposerId] = { texts: [], closed: false };
      emit({
        source: "db",
        hook: "subagentStart",
        conversationId: b.subagentComposerId,
        payload: {
          conversation_id: b.subagentComposerId,
          parent_conversation_id: snap.cid,
          subagent_id: b.subagentComposerId,
          description: desc || "子代理",
          task: desc,
          bubble_id: b.id,
        },
      });
    }
    const toolDone = b.toolName && (b.toolStatus === "completed" || b.toolStatus === "error");
    if (b.type === 2 && b.text.trim() && toolDone && !next.assistants.includes(b.id)) {
      next.assistants.push(b.id);
      emit({
        source: "db",
        hook: "afterAgentResponse",
        conversationId: snap.cid,
        payload: { text: b.text, conversation_id: snap.cid, bubble_id: b.id },
      });
    }
  };

  // r-97b7ca05: the feed already emitted later users and moved on, so the
  // turn-boundary flush never saw these text bubbles. Closed turns still owe
  // their bodies. The open turn (bubbles after the last user) stays unflushed.
  const closedThrough = lastUserIndex(snap.bubbles);
  if (closedThrough > 0) {
    let owner = -1;
    for (let i = 0; i < closedThrough; i++) {
      const b = snap.bubbles[i];
      if (!b) continue;
      if (b.type === 1 && b.text.trim()) owner = i;
      if (owner < 0) continue;
      let boundary = -1;
      for (let j = i + 1; j <= closedThrough; j++) {
        const n = snap.bubbles[j];
        if (n?.type === 1 && n.text.trim()) { boundary = j; break; }
      }
      if (boundary < 0 || !next.users.includes(snap.bubbles[boundary]!.id)) continue;
      flushText(b, snap.bubbles[owner]!.requestId.trim() || null);
    }
  }

  // A finished composer turn often never shows uuid=null: the next user bubble
  // replaces chatGenerationUUID first. Flush the text-only answer and stop the
  // previous generation before that user is emitted, or the body is skipped and
  // the card stays running. A uuid swap with no new user is a resume — leave it.
  const newUserAt = snap.bubbles.findIndex((b) => b.type === 1 && b.text.trim() && !next.users.includes(b.id));
  const priorGen = next.generationId;
  const genChanged = !!(snap.generationId && priorGen && snap.generationId !== priorGen);
  const uuidGone = !snap.generationId && next.sawGeneration;
  const turnMoved = genChanged || uuidGone || next.abortSeen;
  let cut = -1;
  if (newUserAt > 0 && turnMoved) cut = newUserAt;
  else if (genChanged && next.sawGeneration && !next.stopped) {
    let lastKnown = -1;
    for (let i = 0; i < snap.bubbles.length; i++) {
      const b = snap.bubbles[i];
      if (b?.type === 1 && b.text.trim() && next.users.includes(b.id)) lastKnown = i;
    }
    if (lastKnown > 0) cut = lastKnown;
  }
  // r-6ddc3f97: uuid already moved on an earlier tick, so genChanged is false when
  // the protocol user shows up. Flush the text sitting in front of that user.
  // Do not stop — that sentence is still this card's turn.
  if (
    newUserAt > 0 && !turnMoved && !next.stopped && next.sawGeneration
    && snap.generationId && next.armedGen === snap.generationId
  ) {
    const prevGen = requestIdBefore(snap.bubbles, newUserAt);
    if (prevGen && prevGen !== snap.generationId) {
      for (const b of snap.bubbles.slice(0, newUserAt)) flushText(b, prevGen);
    }
  }
  if (cut > 0 && next.sawGeneration && !next.stopped && turnMoved) {
    let flushed = false;
    for (const b of snap.bubbles.slice(0, cut)) {
      if (flushText(b, priorGen) || flushedNow.has(b.id)) flushed = true;
    }
    const stopForNewUser = newUserAt > 0;
    if ((stopForNewUser || flushed) && !childStillBusy(snap, children, next)) {
      const hadText = snap.bubbles.slice(0, cut).some((b) => b.type === 2 && !!b.text.trim() && next.assistants.includes(b.id));
      const cutting = stopForNewUser ? snap.bubbles[newUserAt] : undefined;
      // 系统通知和协议句是同一轮的续写。前面已经有助手正文也先不收口，
      // 否则卡片变成完成，桌面立刻弹「任务完成」，这句后面的工具还在跑。
      // 操作员自己的下一句仍收口。
      const continuation = stopForNewUser
        && snap.status !== "error"
        && operatorAlertPrompt(cutting?.text ?? "") == null;
      if (continuation) heldForContinuation = true;
      else {
        next.stopped = true;
        // armedGen 是用户 requestId。priorGen 常常只是 chatGenerationUUID，对不上中台 live。
        const closeGen = next.armedGen || priorGen;
        emit({
          source: "db",
          hook: "stop",
          conversationId: snap.cid,
          payload: {
            status: hadText ? "completed" : snap.status === "error" ? "error" : "aborted",
            conversation_id: snap.cid,
            ...(closeGen ? { generation_id: closeGen } : {}),
          },
        });
      }
    }
  }

  // Card was already stopped, so the feed was not watching. A Cursor-typed turn
  // is a new user whose requestId is that turn's generation. Flush its body
  // before any later live user, or the prompt lands and the answer never does.
  if (next.stopped && newUserAt >= 0) {
    const groups = unseenTurnGroups(snap.bubbles, next.users);
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g]!;
      const isLast = g === groups.length - 1;
      const live = isLast && !!snap.generationId && (!group.gen || group.gen === snap.generationId);
      const gen = group.gen || (live ? snap.generationId : null);
      const slice = snap.bubbles.slice(group.start, group.end);
      next.stopped = false;
      for (const b of slice) {
        if (b.type === 1 && b.text.trim() && !next.users.includes(b.id)) {
          emit(bsp(snap, b, gen));
          next.users.push(b.id);
          if (gen) next.armedGen = gen;
        }
        noteBubble(b, gen);
        if (!live) flushText(b, gen);
      }
      const hold = isLast && !live && !snap.generationId && snap.status === "aborted" && !next.abortSeen;
      if (gen) {
        next.generationId = gen;
        next.sawGeneration = true;
      }
      if (live || hold) continue;
      if (!childStillBusy(snap, children, next)) {
        const hadText = slice.some((b) => b.type === 2 && !!b.text.trim() && next.assistants.includes(b.id));
        const freshText = slice.some((b) => b.type === 2 && !!b.text.trim() && !b.toolName && !cursor.assistants.includes(b.id));
        // r-5d82dd7b / r-7a755f88: status is still the previous turn's completed
        // or aborted, and a step row already emitted sits after the new user.
        // That is not this turn's reply. Cursor leaves status at aborted after
        // a normal turn, so completed/success alone does not cover it.
        if (isLast && !freshText && (doneStatus(snap.status) || snap.status === "aborted")) continue;
        next.stopped = true;
        emit({
          source: "db",
          hook: "stop",
          conversationId: snap.cid,
          payload: {
            status: hadText ? "completed" : isLast && snap.status === "error" ? "error" : "aborted",
            conversation_id: snap.cid,
            ...(gen ? { generation_id: gen } : {}),
          },
        });
      }
    }
  }

  const openAt = lastUserIndex(snap.bubbles);
  const openReq = openAt >= 0 ? (snap.bubbles[openAt]?.requestId.trim() || "") : "";
  if (snap.generationId) {
    // requestId 和 chatGenerationUUID 可以整轮都不是同一个。已用 requestId 收口时不要解开。
    const armedIsThisTurn = next.armedGen === snap.generationId || (openReq !== "" && next.armedGen === openReq);
    if (next.stopped && !armedIsThisTurn) next.stopped = false;
    next.generationId = snap.generationId;
    next.sawGeneration = true;
  }

  for (let i = 0; i < snap.bubbles.length; i++) {
    const b = snap.bubbles[i]!;
    if (b.type !== 1 || !b.text.trim() || next.users.includes(b.id)) continue;
    const owning = generationOwning(snap.bubbles, i, snap.generationId);
    emit(bsp(snap, b, owning));
    next.users.push(b.id);
    // 用户 requestId 才是中台 live。chatGenerationUUID 写进 armedGen 后，
    // stop 对不上，decideStop 记 STOP_GEN_MISMATCH，卡片一直转圈（r-17a94c8c）。
    if (i === openAt && owning) next.armedGen = owning;
  }
  const lastUser = openAt >= 0 ? snap.bubbles[openAt] : undefined;
  // 这一轮自己的 /s:n 已经写完。uuid 换成另一个值也要收口，不能再武装成新的一轮。
  const finishedOnSwap = genChanged && ownStepSettled(snap, openReq) != null;
  // 只有 uuid 中途换成另一轮才改 armedGen。开局就和 requestId 不同的 uuid 不能盖掉 requestId。
  if (!finishedOnSwap && lastUser && snap.generationId && genChanged && next.armedGen !== snap.generationId) {
    emit(bsp(snap, lastUser));
    next.armedGen = snap.generationId;
  }

  for (let i = 0; i < snap.bubbles.length; i++) {
    noteBubble(snap.bubbles[i]!, generationOwning(snap.bubbles, i, snap.generationId));
  }

  for (const id of snap.subagentIds) {
    if (!next.children[id]) {
      next.children[id] = { texts: [], closed: false };
      emit({
        source: "db",
        hook: "subagentStart",
        conversationId: id,
        payload: {
          conversation_id: id,
          parent_conversation_id: snap.cid,
          subagent_id: id,
          description: "子代理",
          task: "",
        },
      });
    }
  }

  let childBusy = false;
  for (const child of children) {
    const cur = childOf(next, child.cid);
    const released = childReleaseStatus(snap, child.cid);
    if (child.generationId && !released) childBusy = true;
    for (const b of child.bubbles) {
      if (b.type !== 2 || !b.text.trim() || cur.texts.includes(b.text)) continue;
      cur.texts.push(b.text);
      emit({
        source: "subagent-transcript",
        hook: null,
        conversationId: child.cid,
        payload: {
          __subagent_cid: child.cid,
          parent_conversation_id: snap.cid,
          role: "assistant",
          message: { content: [{ type: "text", text: b.text }] },
        },
      });
    }
    // shortcut: a child with no uuid and no text stays open, so the parent stop waits. Upgrade if a child never receives chatGenerationUUID.
    const sawWork = cur.texts.length > 0 || !!child.generationId;
    const selfDone = !child.generationId && (
      doneStatus(child.status) || (sawWork && (child.status === "aborted" || child.status === "error"))
    );
    if (!cur.closed && (released || selfDone)) {
      cur.closed = true;
      emit({
        source: "subagent-transcript",
        hook: null,
        conversationId: child.cid,
        payload: {
          __subagent_cid: child.cid,
          parent_conversation_id: snap.cid,
          type: "turn_ended",
          status: released ?? (doneStatus(child.status) ? "success" : child.status),
        },
      });
    } else if (!cur.closed && !doneStatus(child.status)) {
      childBusy = true;
    }
    next.children[child.cid] = cur;
  }

  // An already-flushed step can still be growing. Emit the longer text on this
  // tick, including after the card has stopped, so the detail is not stuck on
  // the first snapshot.
  for (let i = 0; i < snap.bubbles.length; i++) {
    const b = snap.bubbles[i]!;
    if (!next.assistantText[b.id]) continue;
    flushText(b, generationOwning(snap.bubbles, i, snap.generationId));
  }

  const uuidCleared = !snap.generationId && (next.sawGeneration || doneStatus(snap.status));
  const abortHold = uuidCleared && snap.status === "aborted" && !next.abortSeen;
  if (abortHold) next.abortSeen = true;
  if (snap.generationId) next.abortSeen = false;
  if (uuidCleared && !abortHold && !next.stopped && !childBusy && !heldForContinuation) {
    const owned = turnSlice(snap.bubbles, next.generationId);
    const earlierHasBody = owned.owner > 0 && snap.bubbles.slice(0, owned.owner).some(bubbleIsBody);
    const freshWork = owned.slice.some((b) => bubbleIsBody(b) && !bodyAlreadyEmitted(b, cursor));
    // Idle composer status belongs to the turn that already has bubbles.
    // A newer user with no new body has not finished, so that status must not close it.
    // A step that already recorded turnDurationMs is this turn's reply, even if that
    // text was flushed on an earlier tick.
    if (!freshWork && earlierHasBody && !settledOpenTurn(snap, next.generationId).ok) {
      return { events, cursor: next };
    }
    for (const b of owned.slice) flushText(b, next.generationId);
    // Cursor leaves composer status at "aborted" after a normal Windows turn.
    // A reply of this generation is completion. Aborted with no reply stays aborted.
    const hadText = owned.slice.some((b) => b.type === 2 && !!b.text.trim() && !b.toolName && next.assistants.includes(b.id));
    const stopStatus = hadText || doneStatus(snap.status) ? "completed"
      : snap.status === "error" ? "error"
      : snap.status === "aborted" ? "aborted"
      : "completed";
    next.stopped = true;
    emit({
      source: "db",
      hook: "stop",
      conversationId: snap.cid,
      payload: {
        status: stopStatus,
        conversation_id: snap.cid,
        // r-ac71f2e4: a later thought can carry an older turn's requestId.
        // The armed submit is the generation decideStop compares to live.
        ...((next.armedGen || next.generationId) ? { generation_id: next.armedGen || next.generationId } : {}),
      },
    });
  }
  if (!next.stopped && !childBusy && !heldForContinuation) {
    const gen = snap.generationId ?? next.generationId;
    let settled = settledOpenTurn(snap, gen);
    const req = lastUser?.requestId.trim() || "";
    // uuid 从这一轮开始就和 requestId 不是同一个。不能等 uuid 清空。
    // uuid 换成另一个值、又没有新用户气泡：没有 /s:n 父气泡的时长仍是续跑。
    // 这一轮自己的 /s:n 已经写完时要收口，否则正文要等下一条用户消息（r-87f1e2cc）。
    if (!settled.ok && req && req !== gen) {
      if (!genChanged) settled = settledOpenTurn(snap, req);
      else {
        const own = ownStepSettled(snap, req);
        if (own) settled = own;
      }
    }
    if (settled.ok) {
      const ownerGen = snap.bubbles[settled.owner]?.requestId || gen;
      const stopGen = snap.generationId ? ownerGen : (next.armedGen || ownerGen);
      for (const b of settled.slice) flushText(b, ownerGen);
      next.stopped = true;
      emit({
        source: "db",
        hook: "stop",
        conversationId: snap.cid,
        payload: {
          status: "completed",
          conversation_id: snap.cid,
          ...(stopGen ? { generation_id: stopGen } : {}),
        },
      });
    }
  }
  // The follow-up was already closed before its /s:n row existed (r-7a755f88).
  // Emit that step once it arrives. A step of any other parent stays out.
  if (cursor.stopped) {
    for (const b of snap.bubbles) {
      const parent = stepParent(b.id);
      if (!parent || !cursor.users.includes(parent)) continue;
      const owner = snap.bubbles.find((u) => u.type === 1 && u.id === parent);
      flushText(b, owner?.requestId.trim() || null);
    }
  }
  return { events, cursor: next };
}

export function seedCursor(snap: ComposerView, children: ComposerView[], priorEvents: number): ComposerCursor {
  const c = emptyCursor();
  if (priorEvents <= 0) return c;
  for (const b of snap.bubbles) {
    if (b.type === 1) c.users.push(b.id);
    if (b.thinking) c.thoughts.push(`${b.id}\0${b.thinking}`);
    if (b.toolName) c.tools.push(b.id);
    if (b.type === 2 && b.text.trim() && b.toolName) c.assistants.push(b.id);
  }
  if (snap.generationId) {
    c.generationId = snap.generationId;
    c.sawGeneration = true;
  } else if (doneStatus(snap.status)) {
    c.sawGeneration = true;
  }
  for (const child of children) {
    c.children[child.cid] = {
      texts: child.bubbles.filter((b) => b.type === 2 && b.text.trim()).map((b) => b.text),
      closed: !child.generationId && doneStatus(child.status),
    };
  }
  for (const id of snap.subagentIds) {
    if (!c.children[id]) c.children[id] = { texts: [], closed: false };
  }
  return c;
}

type Emitted = { source: string; hook: string | null; payload: Record<string, unknown> };

export function cursorFromEmitted(events: Emitted[]): ComposerCursor {
  const c = emptyCursor();
  let stoppedGen: string | null = null;
  for (const ev of events) {
    const p = ev.payload ?? {};
    const bubble = typeof p.bubble_id === "string" ? p.bubble_id : "";
    const gen = typeof p.generation_id === "string" && p.generation_id ? p.generation_id : null;
    if (gen) {
      c.generationId = gen;
      c.sawGeneration = true;
    }
    if (ev.hook === "beforeSubmitPrompt") {
      if (bubble && !c.users.includes(bubble)) c.users.push(bubble);
      if (gen) c.armedGen = gen;
      // A later submit is a new turn. The previous stop must not stay latched
      // after the hub rebuilds this cursor (r-2aadbcbc overlay restart).
      if (c.stopped && gen && stoppedGen && gen !== stoppedGen) c.stopped = false;
    }
    if (ev.hook === "afterAgentThought" && bubble && typeof p.text === "string") {
      const key = `${bubble}\0${p.text}`;
      if (!c.thoughts.includes(key)) c.thoughts.push(key);
    }
    if (ev.hook === "preToolUse" && bubble && !c.tools.includes(bubble)) c.tools.push(bubble);
    if (ev.hook === "afterAgentResponse" && bubble && typeof p.text === "string") {
      const text = p.text.trim();
      if (text) {
        const prev = c.assistantText[bubble];
        if (!prev || (text.startsWith(prev) && text.length > prev.length)) c.assistantText[bubble] = text;
        if (!c.assistants.includes(bubble)) c.assistants.push(bubble);
      }
    }
    if (ev.hook === "subagentStart" && typeof p.conversation_id === "string") {
      if (!c.children[p.conversation_id]) c.children[p.conversation_id] = { texts: [], closed: false };
    }
    if (ev.hook === "stop") {
      c.stopped = true;
      stoppedGen = gen ?? c.generationId;
    }
    if (ev.source === "subagent-transcript") {
      const cid = typeof p.__subagent_cid === "string" ? p.__subagent_cid : "";
      if (!cid) continue;
      const child = c.children[cid] ?? { texts: [], closed: false };
      if (p.type === "turn_ended") child.closed = true;
      const parts = (p.message as { content?: { type?: string; text?: string }[] } | undefined)?.content;
      const text = Array.isArray(parts) ? parts.filter((x) => x?.type === "text").map((x) => x.text ?? "").join("\n") : "";
      if (text && !child.texts.includes(text)) child.texts.push(text);
      c.children[cid] = child;
    }
  }
  return c;
}
