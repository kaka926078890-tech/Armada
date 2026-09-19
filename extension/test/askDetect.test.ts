import { describe, expect, test } from "bun:test";
import { askPollActions, coalesceAskInspect, nextAskAction, parseAskInspect, parsePlanInspect, planInspectToAsk } from "../src/askDetect";

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

  test("unknown inspect keeps pending and does not resolve", () => {
    expect(nextAskAction("ask-1", { unknown: true, reason: "CDP_UNREACHABLE" }, () => "x")).toBeNull();
    expect(nextAskAction(null, { unknown: true, reason: "CDP_CONNECT_FAIL" }, () => "x")).toBeNull();
  });

  test("no options does not emit", () => {
    expect(nextAskAction(null, { present: true, prompt: "x", conversation_id: "cid-1", options: [] }, () => "ask-1")).toBeNull();
  });

  test("plan body growing reuses request_id so hub can replace the short overview", () => {
    const short = {
      present: true as const,
      kind: "plan" as const,
      filename: "Markdown date line",
      prompt: "Created Plan: Markdown date line",
      conversation_id: "cid-1",
      options: [{ id: "build", label: "Build", text: "追加一行日期" }],
    };
    const full = {
      ...short,
      options: [{ id: "build", label: "Build", text: "# 在 markdown 追加日期\n\n在任意一份现有 markdown 末尾追加一行。" }],
    };
    expect(nextAskAction("ask-plan-1", short, () => "ask-2", 9, "追加一行日期")).toBeNull();
    const again = nextAskAction("ask-plan-1", full, () => "ask-2", 9, "追加一行日期");
    expect(again).toMatchObject({
      type: "askQuestion",
      payload: { request_id: "ask-plan-1", kind: "plan" },
    });
    expect(again && again.type === "askQuestion" ? again.payload.questions[0].options[0].text : "").toContain("# 在 markdown 追加日期");
  });
});

describe("parseAskInspect", () => {
  test("drops absent and empty", () => {
    expect(parseAskInspect(null)).toEqual({ present: false });
    expect(parseAskInspect({ present: false })).toEqual({ present: false });
  });

  test("preserves unknown so CDP failure is not absent", () => {
    expect(parseAskInspect({ unknown: true, reason: "CDP_UNREACHABLE" })).toEqual({
      unknown: true, reason: "CDP_UNREACHABLE",
    });
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

  test("keeps skip_unidentified from inspect parsing", () => {
    const got = parseAskInspect({
      present: true,
      prompt: "选一个",
      conversation_id: "cid-1",
      options: [{ id: "a", label: "A", text: "甲" }, { id: "b", label: "B", text: "乙" }],
      skip_unidentified: true,
    });
    expect(got).toMatchObject({ present: true, skip_unidentified: true });
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

  test("missing composer id with one bound run stamps that run cid", () => {
    const bound = new Map([["r-1", { conversationId: "cid-1" }]]);
    const acts = askPollActions(bound, new Map(), { ...inspect, conversation_id: "" }, () => "ask-1");
    expect(acts).toEqual([
      expect.objectContaining({
        type: "askQuestion",
        runId: "r-1",
        payload: expect.objectContaining({ request_id: "ask-1", conversation_id: "cid-1" }),
      }),
    ]);
  });

  test("missing composer id with two bound runs is fail-closed", () => {
    const bound = new Map<string, { conversationId: string }>([
      ["r-1", { conversationId: "cid-1" }],
      ["r-2", { conversationId: "cid-2" }],
    ]);
    const acts = askPollActions(bound, new Map(), { ...inspect, conversation_id: "" }, () => "ask-1");
    expect(acts).toEqual([]);
  });

  test("PF39WTSM 09:36: empty cid ignores completed leftover and stamps the unique live run", () => {
    const bound = new Map<string, { conversationId: string }>([
      ["r-c424f731-17ef-4ae1-9bf5-db9fbc85b73b", { conversationId: "ca3d4388-990d-44cc-bb43-b472bee8812c" }],
      ["r-645dd1c8-1054-4c88-be6c-2143cdfaba53", { conversationId: "c742be7e-4808-4639-9ea5-df35ecd99ce8" }],
    ]);
    const acts = askPollActions(
      bound,
      new Map(),
      { ...inspect, conversation_id: "" },
      () => "ask-live",
      Date.now(),
      ["r-645dd1c8-1054-4c88-be6c-2143cdfaba53"],
    );
    expect(acts).toEqual([
      expect.objectContaining({
        type: "askQuestion",
        runId: "r-c424f731-17ef-4ae1-9bf5-db9fbc85b73b",
        payload: expect.objectContaining({
          request_id: "ask-live",
          conversation_id: "ca3d4388-990d-44cc-bb43-b472bee8812c",
        }),
      }),
    ]);
  });

  test("empty cid with two live runs stays fail-closed even if a third is stopped", () => {
    const bound = new Map<string, { conversationId: string }>([
      ["r-live-a", { conversationId: "cid-a" }],
      ["r-live-b", { conversationId: "cid-b" }],
      ["r-dead", { conversationId: "cid-dead" }],
    ]);
    const acts = askPollActions(
      bound,
      new Map(),
      { ...inspect, conversation_id: "" },
      () => "ask-1",
      Date.now(),
      ["r-dead"],
    );
    expect(acts).toEqual([]);
  });

  test("plan Ask still attaches to a stopped cid owner so hub can reopen Build", () => {
    const bound = new Map([["r-plan", { conversationId: "cid-plan" }]]);
    const plan = {
      present: true as const,
      kind: "plan" as const,
      filename: "Markdown date line",
      prompt: "Created Plan: Markdown date line",
      conversation_id: "cid-plan",
      options: [{ id: "build", label: "Build", text: "Build" }],
    };
    const acts = askPollActions(bound, new Map(), plan, () => "ask-plan", 9, ["r-plan"]);
    expect(acts).toEqual([
      expect.objectContaining({ type: "askQuestion", runId: "r-plan" }),
    ]);
  });

  test("gone widget resolves only the owner that had pending", () => {
    const bound = new Map([["r-1", { conversationId: "cid-1" }]]);
    const acts = askPollActions(bound, new Map([["r-1", "ask-1"]]), { present: false }, () => "x");
    expect(acts).toEqual([{ type: "askQuestionResolved", runId: "r-1", request_id: "ask-1" }]);
  });

  test("unknown inspect with pending does not emit resolved", () => {
    const bound = new Map([["r-1", { conversationId: "cid-1" }]]);
    const acts = askPollActions(
      bound,
      new Map([["r-1", "ask-1"]]),
      { unknown: true, reason: "CDP_UNREACHABLE" },
      () => "x",
    );
    expect(acts).toEqual([]);
  });
});

describe("coalesceAskInspect", () => {
  test("present true wins over unknown and false", () => {
    const present = {
      present: true as const,
      prompt: "q",
      conversation_id: "cid-1",
      options: [{ id: "a", label: "A", text: "甲" }],
    };
    expect(coalesceAskInspect([
      { unknown: true, reason: "WINDOW_TARGET_NOT_FOUND" },
      present,
    ])).toEqual(present);
  });

  test("confirmed false is not overwritten by unknown from another root", () => {
    expect(coalesceAskInspect([
      { unknown: true, reason: "WINDOW_TARGET_NOT_FOUND" },
      { present: false },
    ])).toEqual({ present: false });
  });

  test("all unknown stays unknown", () => {
    expect(coalesceAskInspect([
      { unknown: true, reason: "CDP_UNREACHABLE" },
      { unknown: true, reason: "CDP_CONNECT_FAIL" },
    ])).toEqual({ unknown: true, reason: "CDP_CONNECT_FAIL" });
  });
});

describe("Created Plan inspect", () => {
  test("planInspectToAsk is a single Build option owned by composer cid", () => {
    const plan = parsePlanInspect({
      present: true,
      filename: "Markdown date line",
      overview: "在任意一份现有 markdown 文件末尾追加一行日期",
      conversation_id: "17ce6eee-b18a-4550-9548-b1b50040ca27",
    });
    expect(plan.present).toBe(true);
    const ask = planInspectToAsk(plan);
    expect(ask).toMatchObject({
      present: true,
      kind: "plan",
      filename: "Markdown date line",
      conversation_id: "17ce6eee-b18a-4550-9548-b1b50040ca27",
      options: [{ id: "build", label: "Build" }],
    });
    const bound = new Map([["r-plan", { conversationId: "17ce6eee-b18a-4550-9548-b1b50040ca27" }]]);
    const acts = askPollActions(bound, new Map(), ask, () => "ask-plan-1", 9);
    expect(acts).toEqual([
      expect.objectContaining({
        type: "askQuestion",
        runId: "r-plan",
        payload: expect.objectContaining({ kind: "plan", request_id: "ask-plan-1" }),
      }),
    ]);
  });
});
