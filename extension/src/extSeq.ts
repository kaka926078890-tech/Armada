/**
 * Hub dedupes `run_events` on UNIQUE(machine_id, ext_seq).
 * Windows transcript events used to start at 1_000_000_000 every
 * extension host start. After Reload that band is already occupied by
 * earlier runs, so hub acks the "dup" and drops synthesized `stop` —
 * the card stays 运行中 forever even though jsonl already has turn_ended.
 *
 * Seed from the clock so a new session never rewinds into a used band.
 */
export function createExtSeq(now: () => number = Date.now): () => number {
  let n = now();
  return () => {
    n += 1;
    return n;
  };
}
