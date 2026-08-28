import { describe, expect, test } from "bun:test";
import { CancelWatcher } from "../src/executor";

describe("CancelWatcher", () => {
  test("same cid+prompt resubmit within 20s → cancel again (max 2)", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "hello", 100_000);
    const ev = { hook: "beforeSubmitPrompt", raw: { conversation_id: "cid-1", prompt: "hello" } };
    expect(w.shouldCancelAgain(ev, 105_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(ev, 110_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(ev, 115_000)).toBeNull(); // 已达 2 次上限
  });

  test("different prompt → no re-cancel", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "hello", 100_000);
    expect(w.shouldCancelAgain({ hook: "beforeSubmitPrompt", raw: { conversation_id: "cid-1", prompt: "changed" } }, 105_000)).toBeNull();
  });

  test("after 20s window → no re-cancel", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "hello", 100_000);
    expect(w.shouldCancelAgain({ hook: "beforeSubmitPrompt", raw: { conversation_id: "cid-1", prompt: "hello" } }, 121_000)).toBeNull();
  });

  test("unrelated hook ignored", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "hello", 100_000);
    expect(w.shouldCancelAgain({ hook: "preToolUse", raw: { conversation_id: "cid-1" } }, 105_000)).toBeNull();
  });
});
