import { describe, expect, test } from "bun:test";
import { collectEventPages, mergeEvents, EVENT_PAGE_SIZE } from "../src/loadEvents";

describe("collectEventPages", () => {
  test("walks afterSeq until a short page so followup replies past the first 500 are kept", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, hook: "preToolUse" }));
    const page2 = [
      { seq: 501, hook: "beforeSubmitPrompt" },
      { seq: 545, hook: "afterAgentResponse" },
    ];
    const calls: number[] = [];
    const fetchPage = async (afterSeq: number) => {
      calls.push(afterSeq);
      if (afterSeq === 0) return page1;
      if (afterSeq === 500) return page2;
      return [];
    };
    const all = await collectEventPages(fetchPage, 0, EVENT_PAGE_SIZE);
    expect(all).toHaveLength(502);
    expect(all.at(-1)).toEqual({ seq: 545, hook: "afterAgentResponse" });
    expect(calls).toEqual([0, 500]);
  });

  test("stops when last seq does not advance", async () => {
    let n = 0;
    const fetchPage = async () => {
      n++;
      return [{ seq: 1 }];
    };
    const all = await collectEventPages(fetchPage, 0, 500);
    expect(all).toHaveLength(1);
    expect(n).toBe(1);
  });
});

describe("mergeEvents", () => {
  test("dedupes by seq and keeps order", () => {
    const merged = mergeEvents(
      [{ seq: 1, id: "a" }, { seq: 2, id: "b" }],
      [{ seq: 2, id: "b2" }, { seq: 3, id: "c" }],
    );
    expect(merged.map((e) => [e.seq, e.id])).toEqual([[1, "a"], [2, "b2"], [3, "c"]]);
  });
});
