/** Client-side read queue. The hub merges; this only remembers what we have not acked. */

export type ReadOp =
  | { op: "stamp"; runId: string; at: number }
  | { op: "clear"; runId: string };

export type PendingRead = { baseSeq: number; op: "stamp" | "clear"; runId: string; at?: number };

export function localStampsToUpload(local: Record<string, number>, server: Record<string, number>): ReadOp[] {
  const ops: ReadOp[] = [];
  for (const [runId, at] of Object.entries(local)) {
    const seen = server[runId];
    if (seen == null || at > seen) ops.push({ op: "stamp", runId, at });
  }
  return ops;
}

export function coalesceReadOps(pending: PendingRead[]): PendingRead[] {
  const last = new Map<string, PendingRead>();
  const order: string[] = [];
  for (const op of pending) {
    if (!last.has(op.runId)) order.push(op.runId);
    last.set(op.runId, op);
  }
  return order.map((id) => last.get(id)!);
}

export function applyPendingReads(server: Record<string, number>, pending: PendingRead[]): Record<string, number> {
  const next = { ...server };
  for (const op of coalesceReadOps(pending)) {
    if (op.op === "clear") delete next[op.runId];
    else if (typeof op.at === "number") next[op.runId] = Math.max(next[op.runId] ?? 0, op.at);
  }
  return next;
}

export function takeReadBatches(pending: PendingRead[]): { baseSeq: number; ops: ReadOp[] }[] {
  const order: number[] = [];
  const map = new Map<number, ReadOp[]>();
  for (const op of coalesceReadOps(pending)) {
    if (!map.has(op.baseSeq)) {
      order.push(op.baseSeq);
      map.set(op.baseSeq, []);
    }
    if (op.op === "clear") map.get(op.baseSeq)!.push({ op: "clear", runId: op.runId });
    else if (typeof op.at === "number") map.get(op.baseSeq)!.push({ op: "stamp", runId: op.runId, at: op.at });
  }
  return order.map((baseSeq) => ({ baseSeq, ops: map.get(baseSeq)! }));
}

export function readSseShouldPull(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { type?: unknown }).type === "read.updated";
  } catch {
    return false;
  }
}
