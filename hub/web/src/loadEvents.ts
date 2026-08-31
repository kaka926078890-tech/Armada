export const EVENT_PAGE_SIZE = 500;

export async function collectEventPages<T extends { seq: number }>(
  fetchPage: (afterSeq: number) => Promise<T[]>,
  afterSeq = 0,
  pageSize = EVENT_PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  let after = afterSeq;
  while (true) {
    const batch = await fetchPage(after);
    if (!Array.isArray(batch) || batch.length === 0) break;
    const last = batch[batch.length - 1]?.seq;
    if (typeof last !== "number" || last <= after) break;
    all.push(...batch);
    after = last;
    if (batch.length < pageSize) break;
  }
  return all;
}

export function mergeEvents<T extends { seq: number }>(prev: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return prev;
  const bySeq = new Map<number, T>();
  for (const e of prev) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
}
