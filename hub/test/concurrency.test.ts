import { describe, expect, test } from "bun:test";
import { normalizePrompt } from "../../extension/src/promptNormalize";
import { limitsFromEnv, extensionSupportsMultiRunPerWindow, httpStatusForRunError } from "../src/concurrency";

describe("normalizePrompt", () => {
  test("trims, strips CR, collapses whitespace", () => {
    expect(normalizePrompt("  hello\r\n  world  ")).toBe("hello world");
  });
});

describe("limitsFromEnv", () => {
  test("defaults 8/4/multi-on", () => {
    expect(limitsFromEnv({})).toEqual({ maxPerMachine: 8, maxPerWorkspace: 4, multiRunPerWindow: true });
  });
  test("clamps and enforces M <= N", () => {
    const l = limitsFromEnv({
      ARMADA_MAX_RUNS_PER_MACHINE: "2",
      ARMADA_MAX_RUNS_PER_WORKSPACE: "9",
    });
    expect(l.maxPerMachine).toBe(2);
    expect(l.maxPerWorkspace).toBe(2);
  });
  test("MULTI_RUN_PER_WINDOW=0 disables same-window parallel", () => {
    expect(limitsFromEnv({ ARMADA_MULTI_RUN_PER_WINDOW: "0" }).multiRunPerWindow).toBe(false);
  });
});

describe("extensionSupportsMultiRunPerWindow", () => {
  test("0.4.0+ yes, missing and 0.3.8 no", () => {
    expect(extensionSupportsMultiRunPerWindow("0.4.0")).toBe(true);
    expect(extensionSupportsMultiRunPerWindow("0.3.8")).toBe(false);
    expect(extensionSupportsMultiRunPerWindow(null)).toBe(false);
  });
});

describe("httpStatusForRunError", () => {
  test("maps limit/collision/offline", () => {
    expect(httpStatusForRunError("RUN_LIMIT")).toBe(429);
    expect(httpStatusForRunError("PROMPT_COLLISION")).toBe(409);
    expect(httpStatusForRunError("CONVERSATION_BUSY")).toBe(409);
    expect(httpStatusForRunError("INJECT_SLOT_BUSY")).toBe(409);
    expect(httpStatusForRunError("WINDOW_BUSY")).toBe(409);
    expect(httpStatusForRunError("MACHINE_OFFLINE")).toBe(400);
    expect(httpStatusForRunError("NOT_FOUND")).toBe(404);
    expect(httpStatusForRunError("ATTACHMENT_TOTAL_TOO_LARGE")).toBe(413);
    expect(httpStatusForRunError("EMPTY_PROMPT")).toBe(400);
  });
});
