import { describe, expect, test } from "bun:test";
import { nextAskAction, parseAskInspect } from "../src/askDetect";

describe("nextAskAction", () => {
  const inspect = {
    present: true as const,
    prompt: "选一个",
    options: [{ id: "a", label: "A", text: "甲" }, { id: "b", label: "B", text: "乙" }],
  };

  test("first present emits askQuestion once", () => {
    const a = nextAskAction(null, inspect, () => "ask-1", 9);
    expect(a).toMatchObject({ type: "askQuestion", payload: { request_id: "ask-1", detect_via: "cdp" } });
    expect(nextAskAction("ask-1", inspect, () => "ask-2")).toBeNull();
  });

  test("gone after pending emits resolved; gone with no prev is silent", () => {
    expect(nextAskAction("ask-1", { present: false }, () => "x")).toEqual({
      type: "askQuestionResolved", request_id: "ask-1",
    });
    expect(nextAskAction(null, { present: false }, () => "x")).toBeNull();
  });

  test("no options does not emit", () => {
    expect(nextAskAction(null, { present: true, prompt: "x", options: [] }, () => "ask-1")).toBeNull();
  });
});

describe("parseAskInspect", () => {
  test("drops absent and empty", () => {
    expect(parseAskInspect(null)).toEqual({ present: false });
    expect(parseAskInspect({ present: false })).toEqual({ present: false });
  });
});
