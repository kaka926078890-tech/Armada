import { describe, expect, test } from "bun:test";
import { applyReadOps, normalizeReadState, parseReadOps, readViewOf, type ReadState } from "../src/readSync";

const empty: ReadState = { seq: 0, marks: {} };

describe("applyReadOps", () => {
  test("two stamps keep the later watermark and a clear removes it", () => {
    const stamped = applyReadOps(empty, 0, [
      { op: "stamp", runId: "a", at: 10 },
      { op: "stamp", runId: "a", at: 4 },
    ]);
    expect(readViewOf(stamped).readRuns).toEqual({ a: 10 });
    const cleared = applyReadOps(stamped, stamped.seq, [{ op: "clear", runId: "a" }]);
    expect(readViewOf(cleared).readRuns).toEqual({});
    expect(cleared.marks.a).toEqual({ seq: cleared.seq, at: null });
    const again = applyReadOps(cleared, cleared.seq, [{ op: "clear", runId: "a" }]);
    expect(again.seq).toBe(cleared.seq);
  });

  test("a stale stamp does not revive a newer clear", () => {
    const cleared = applyReadOps(empty, 0, [{ op: "clear", runId: "a" }]);
    const stale = applyReadOps(cleared, 0, [{ op: "stamp", runId: "a", at: 50 }]);
    expect(stale.seq).toBe(cleared.seq);
    expect(readViewOf(stale).readRuns).toEqual({});
  });

  test("clear then stamp in one batch both apply", () => {
    const next = applyReadOps(empty, 0, [
      { op: "clear", runId: "a" },
      { op: "stamp", runId: "a", at: 20 },
    ]);
    expect(readViewOf(next).readRuns).toEqual({ a: 20 });
  });

  test("a newer stamp rejects an older clear", () => {
    const stamped = applyReadOps(empty, 0, [{ op: "stamp", runId: "a", at: 5 }]);
    const rejected = applyReadOps(stamped, 0, [{ op: "clear", runId: "a" }]);
    expect(readViewOf(rejected).readRuns).toEqual({ a: 5 });
  });

  test("legacy readRuns become seq 0 stamps and stay visible", () => {
    const state = normalizeReadState({ readRuns: { a: 3, b: "no" } }, { a: 3 });
    expect(state.marks.a).toEqual({ seq: 0, at: 3 });
    expect(readViewOf(state).readRuns).toEqual({ a: 3 });
    const cleared = applyReadOps(state, 0, [{ op: "clear", runId: "a" }]);
    expect(readViewOf(cleared).readRuns).toEqual({});
  });

  test("parse rejects a full-map shaped body and an oversized batch", () => {
    expect(parseReadOps({ readRuns: { a: 1 } }).ok).toBe(false);
    const ops = Array.from({ length: 201 }, (_, i) => ({ op: "clear", runId: `r${i}` }));
    expect(parseReadOps({ baseSeq: 0, ops }).ok).toBe(false);
    const ok = parseReadOps({ baseSeq: 2, ops: [{ op: "stamp", runId: "a", at: 9 }] });
    expect(ok).toEqual({ ok: true, baseSeq: 2, ops: [{ op: "stamp", runId: "a", at: 9 }] });
  });
});
