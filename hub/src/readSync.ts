/** Operator read flags. Clients send stamp/clear ops. The hub assigns seq. */

export const READ_OPS_MAX = 200;
/** shortcut: a dropped clear tombstone can be revived by a later stale stamp; raise this if clients stay offline across more than 5000 read ops. */
export const READ_MARK_CAP = 5000;

export type ReadMark = { seq: number; at: number | null };
export type ReadState = { seq: number; marks: Record<string, ReadMark> };
export type ReadOp =
  | { op: "stamp"; runId: string; at: number }
  | { op: "clear"; runId: string };

export type ReadView = { seq: number; readRuns: Record<string, number> };

export function readViewOf(state: ReadState): ReadView {
  const readRuns: Record<string, number> = {};
  for (const [id, mark] of Object.entries(state.marks)) {
    if (mark.at != null) readRuns[id] = mark.at;
  }
  return { seq: state.seq, readRuns };
}

function capState(state: ReadState): ReadState {
  const entries = Object.entries(state.marks);
  if (entries.length <= READ_MARK_CAP) return state;
  entries.sort((a, b) => a[1].seq - b[1].seq || (a[1].at ?? 0) - (b[1].at ?? 0));
  return { seq: state.seq, marks: Object.fromEntries(entries.slice(entries.length - READ_MARK_CAP)) };
}

export function normalizeReadState(raw: Record<string, unknown>, fallbackRuns: Record<string, number>): ReadState {
  const fallbackSeq = typeof raw.readSeq === "number" && Number.isFinite(raw.readSeq) && raw.readSeq >= 0
    ? raw.readSeq
    : 0;
  const given = raw.readMarks;
  const givenKeys = given && typeof given === "object" && !Array.isArray(given) ? Object.keys(given as object) : null;
  if (givenKeys && !(givenKeys.length === 0 && Object.keys(fallbackRuns).length > 0)) {
    const marks: Record<string, ReadMark> = {};
    let maxSeq = fallbackSeq;
    for (const [id, value] of Object.entries(given as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const seq = (value as { seq?: unknown }).seq;
      const at = (value as { at?: unknown }).at;
      if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 0) continue;
      if (at == null) marks[id] = { seq, at: null };
      else if (typeof at === "number" && Number.isFinite(at)) marks[id] = { seq, at };
      else continue;
      if (seq > maxSeq) maxSeq = seq;
    }
    return capState({ seq: Math.max(fallbackSeq, maxSeq), marks });
  }
  const marks: Record<string, ReadMark> = {};
  for (const [id, at] of Object.entries(fallbackRuns)) marks[id] = { seq: 0, at };
  return { seq: fallbackSeq, marks };
}

/** One batch shares baseSeq. Ops this batch just wrote do not count as a foreign conflict. */
export function applyReadOps(state: ReadState, baseSeq: number, ops: ReadOp[]): ReadState {
  let seq = state.seq;
  const marks = { ...state.marks };
  const batchSeqs = new Set<number>();
  for (const op of ops) {
    const cur = marks[op.runId];
    const foreign = cur != null && cur.seq > baseSeq && !batchSeqs.has(cur.seq);
    if (op.op === "stamp") {
      if (foreign && cur.at == null) continue;
      const at = cur && cur.at != null ? Math.max(cur.at, op.at) : op.at;
      seq += 1;
      marks[op.runId] = { seq, at };
      batchSeqs.add(seq);
      continue;
    }
    if (foreign && cur.at != null) continue;
    if (cur && cur.at == null) continue;
    seq += 1;
    marks[op.runId] = { seq, at: null };
    batchSeqs.add(seq);
  }
  return capState({ seq, marks });
}

export function parseReadOps(body: unknown):
  { ok: true; baseSeq: number; ops: ReadOp[] } | { ok: false; error: "INVALID" } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "INVALID" };
  const o = body as { baseSeq?: unknown; ops?: unknown };
  if (typeof o.baseSeq !== "number" || !Number.isFinite(o.baseSeq) || o.baseSeq < 0) return { ok: false, error: "INVALID" };
  if (!Array.isArray(o.ops) || o.ops.length > READ_OPS_MAX) return { ok: false, error: "INVALID" };
  const ops: ReadOp[] = [];
  for (const item of o.ops) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: "INVALID" };
    const row = item as { op?: unknown; runId?: unknown; at?: unknown };
    if (typeof row.runId !== "string" || row.runId.length < 1 || row.runId.length > 128) return { ok: false, error: "INVALID" };
    if (row.op === "clear") {
      ops.push({ op: "clear", runId: row.runId });
      continue;
    }
    if (row.op === "stamp" && typeof row.at === "number" && Number.isFinite(row.at) && row.at >= 0) {
      ops.push({ op: "stamp", runId: row.runId, at: row.at });
      continue;
    }
    return { ok: false, error: "INVALID" };
  }
  return { ok: true, baseSeq: o.baseSeq, ops };
}
