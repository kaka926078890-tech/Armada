import { describe, expect, test } from "bun:test";
import {
  collectEventPages, mergeEvents, EVENT_PAGE_SIZE,
  hasOlderEvents, olderEventsQuery, shouldLoadOlder, prependPreserveScroll,
  isStuckToBottom, stickAfterContentResize,
} from "../src/loadEvents";

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

describe("detail tail window", () => {
  test("has older events when the window does not start at seq 1", () => {
    expect(hasOlderEvents([{ seq: 21 }, { seq: 520 }])).toBe(true);
    expect(hasOlderEvents([{ seq: 1 }, { seq: 20 }])).toBe(false);
    expect(hasOlderEvents([])).toBe(false);
  });

  test("older query uses exclusive beforeSeq at the current min", () => {
    expect(olderEventsQuery([{ seq: 21 }, { seq: 520 }])).toEqual({ beforeSeq: 21 });
    expect(olderEventsQuery([{ seq: 1 }, { seq: 20 }])).toBe(null);
    expect(olderEventsQuery([])).toBe(null);
  });

  test("loads older only when scrolled to top, not already loading, and more exists", () => {
    expect(shouldLoadOlder({ scrollTop: 10, hasOlder: true, loading: false })).toBe(true);
    expect(shouldLoadOlder({ scrollTop: 80, hasOlder: true, loading: false })).toBe(false);
    expect(shouldLoadOlder({ scrollTop: 10, hasOlder: true, loading: true })).toBe(false);
    expect(shouldLoadOlder({ scrollTop: 10, hasOlder: false, loading: false })).toBe(false);
  });

  test("prepending older events keeps the same row on screen", () => {
    expect(prependPreserveScroll({ scrollTop: 40, scrollHeight: 200 }, 800)).toBe(640);
  });
});

describe("follow the end when a diagram finishes layout", () => {
  test("a diagram growing under the last screen stays followed", () => {
    expect(isStuckToBottom(1000, 700, 300)).toBe(true);
    expect(stickAfterContentResize({
      wasStuck: true,
      prevScrollHeight: 1000,
      scrollHeight: 1600,
      scrollTop: 700,
      clientHeight: 300,
    })).toBe(true);
  });

  test("a reader who left the end stays there while a diagram grows", () => {
    expect(stickAfterContentResize({
      wasStuck: false,
      prevScrollHeight: 1000,
      scrollHeight: 1600,
      scrollTop: 100,
      clientHeight: 300,
    })).toBe(false);
  });

  test("scrolling up with no growth leaves the end", () => {
    expect(stickAfterContentResize({
      wasStuck: true,
      prevScrollHeight: 1000,
      scrollHeight: 1000,
      scrollTop: 400,
      clientHeight: 300,
    })).toBe(false);
  });

  test("scrolling past the diagram growth leaves the end", () => {
    expect(stickAfterContentResize({
      wasStuck: true,
      prevScrollHeight: 1000,
      scrollHeight: 1400,
      scrollTop: 100,
      clientHeight: 300,
    })).toBe(false);
  });

  test("returning to the end follows again", () => {
    expect(stickAfterContentResize({
      wasStuck: false,
      prevScrollHeight: 1000,
      scrollHeight: 1000,
      scrollTop: 690,
      clientHeight: 300,
    })).toBe(true);
  });

  test("an unmeasured thread does not count its whole height as diagram growth", () => {
    expect(stickAfterContentResize({
      wasStuck: true,
      prevScrollHeight: 0,
      scrollHeight: 1600,
      scrollTop: 100,
      clientHeight: 300,
    })).toBe(false);
  });
});
