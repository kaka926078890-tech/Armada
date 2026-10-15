import { describe, expect, test } from "bun:test";
import { applyPendingReads, localStampsToUpload, readSseShouldPull, takeReadBatches } from "../src/readSync";

describe("read client queue", () => {
  test("upload only local stamps the server does not already cover", () => {
    expect(localStampsToUpload({ a: 5, b: 1, c: 9 }, { a: 5, b: 4 })).toEqual([
      { op: "stamp", runId: "c", at: 9 },
    ]);
  });

  test("pending clear stays unread when the server snapshot still has the stamp", () => {
    const next = applyPendingReads({ a: 5, b: 2 }, [{ baseSeq: 1, op: "clear", runId: "a" }]);
    expect(next).toEqual({ b: 2 });
  });

  test("batches keep the baseSeq captured when the user acted", () => {
    expect(takeReadBatches([
      { baseSeq: 3, op: "stamp", runId: "a", at: 8 },
      { baseSeq: 3, op: "clear", runId: "a" },
      { baseSeq: 1, op: "stamp", runId: "b", at: 4 },
    ])).toEqual([
      { baseSeq: 3, ops: [{ op: "clear", runId: "a" }] },
      { baseSeq: 1, ops: [{ op: "stamp", runId: "b", at: 4 }] },
    ]);
  });

  test("only a read.updated frame pulls the map", () => {
    expect(readSseShouldPull(JSON.stringify({ type: "read.updated", seq: 4 }))).toBe(true);
    expect(readSseShouldPull(JSON.stringify({ type: "run.status" }))).toBe(false);
  });
});
