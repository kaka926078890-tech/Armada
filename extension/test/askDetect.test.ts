import { describe, expect, test } from "bun:test";
import { askPollActions, nextAskAction, parseAskInspect } from "../src/askDetect";

describe("nextAskAction", () => {
  const inspect = {
    present: true as const,
    prompt: "选一个",
    conversation_id: "cid-1",
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
    expect(nextAskAction(null, { present: true, prompt: "x", conversation_id: "cid-1", options: [] }, () => "ask-1")).toBeNull();
  });
});

describe("parseAskInspect", () => {
  test("drops absent and empty", () => {
    expect(parseAskInspect(null)).toEqual({ present: false });
    expect(parseAskInspect({ present: false })).toEqual({ present: false });
  });

  test("keeps conversation_id from composer-bar", () => {
    const got = parseAskInspect({
      present: true,
      prompt: "三机全绿",
      conversation_id: "15eba46c-1011-44b3-9535-f00596728279",
      options: [{ id: "a", label: "A", text: "同题" }],
    });
    expect(got).toMatchObject({ present: true, conversation_id: "15eba46c-1011-44b3-9535-f00596728279" });
  });
});

describe("askPollActions", () => {
  const inspect = {
    present: true as const,
    prompt: "「三机全绿」这次 Mission 里，三台 Cursor 是同一份清单，还是分工？",
    conversation_id: "15eba46c-1011-44b3-9535-f00596728279",
    options: [{ id: "a", label: "A", text: "同题三环境" }, { id: "b", label: "B", text: "分工" }],
  };

  test("foreign widget cid does not attach to last bound run", () => {
    const bound = new Map([["r-2d1c938a", { conversationId: "0e57ba6f-174e-4120-9747-53c2b1d9896f" }]]);
    const acts = askPollActions(bound, new Map(), inspect, () => "ask-wrong");
    expect(acts).toEqual([]);
  });

  test("widget cid wins over Map insertion order (not last key)", () => {
    const bound = new Map<string, { conversationId: string }>([
      ["r-old", { conversationId: "15eba46c-1011-44b3-9535-f00596728279" }],
      ["r-new", { conversationId: "0e57ba6f-174e-4120-9747-53c2b1d9896f" }],
    ]);
    const acts = askPollActions(bound, new Map(), inspect, () => "ask-owner");
    expect(acts).toEqual([
      expect.objectContaining({ type: "askQuestion", runId: "r-old", payload: expect.objectContaining({ request_id: "ask-owner" }) }),
    ]);
  });

  test("missing composer id is fail-closed", () => {
    const bound = new Map([["r-1", { conversationId: "cid-1" }]]);
    const acts = askPollActions(bound, new Map(), { ...inspect, conversation_id: "" }, () => "ask-1");
    expect(acts).toEqual([]);
  });

  test("gone widget resolves only the owner that had pending", () => {
    const bound = new Map([["r-1", { conversationId: "cid-1" }]]);
    const acts = askPollActions(bound, new Map([["r-1", "ask-1"]]), { present: false }, () => "x");
    expect(acts).toEqual([{ type: "askQuestionResolved", runId: "r-1", request_id: "ask-1" }]);
  });
});
