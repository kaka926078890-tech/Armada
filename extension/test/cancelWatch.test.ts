import { describe, expect, test } from "bun:test";
import { CancelWatcher } from "../src/executor";

describe("CancelWatcher", () => {
  test("same cid+prompt resubmit within 20s → cancel again (max 2)", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1", 100_000);
    w.record("r1", "cid-1", "hello", 100_000);
    const ev = { hook: "beforeSubmitPrompt", raw: { conversation_id: "cid-1", prompt: "hello" } };
    expect(w.shouldCancelAgain(ev, 101_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(ev, 102_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(ev, 103_000)).toBeNull(); // 已达 2 次上限
  });

  // 重取消只该收拾 Armada 自己迟到的注入(startRun 持锁 25s、injectPrompt 先 sleep
  // 1500ms 再粘贴回车,所以注入可以晚于 run.cancel 落地)。人手动重发同一段文字
  // 形状完全一样(同 cid、同 prompt、全新 generation_id),不是 Armada 该取消的东西。
  test("Armada's own late injection lands after cancel → still re-cancel", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "hello", 100_000); // operator 取消先到
    w.noteInjection("r1", 101_500); // Armada 迟到的回车
    const ev = { hook: "beforeSubmitPrompt", raw: { conversation_id: "cid-1", prompt: "hello" } };
    expect(w.shouldCancelAgain(ev, 101_600)).toBe("cid-1");
  });

  test("human resubmits same prompt after our injection settled → no re-cancel", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1", 100_000); // Armada 注入并提交
    w.record("r1", "cid-1", "hello", 105_000); // operator 取消
    const ev = { hook: "beforeSubmitPrompt", raw: { conversation_id: "cid-1", prompt: "hello" } };
    // 人在注入结束 13s 后手动重发:仍在 20s 记录窗内,但不是我们造成的提交
    expect(w.shouldCancelAgain(ev, 113_000)).toBeNull();
  });

  test("no injection ever attributed to this run → no re-cancel", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "hello", 100_000);
    const ev = { hook: "beforeSubmitPrompt", raw: { conversation_id: "cid-1", prompt: "hello" } };
    expect(w.shouldCancelAgain(ev, 105_000)).toBeNull();
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
