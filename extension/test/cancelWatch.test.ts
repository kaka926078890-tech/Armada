import { describe, expect, test } from "bun:test";
import { CancelWatcher } from "../src/executor";

function bsp(cid: string, generationId: string, prompt = "hello") {
  return { hook: "beforeSubmitPrompt", raw: { conversation_id: cid, generation_id: generationId, prompt } };
}

describe("CancelWatcher", () => {
  test("same identity resubmit within 20s → cancel again (max 2)", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1", "g-1");
    w.record("r1", "cid-1", undefined, 100_000);
    const ev = bsp("cid-1", "g-1");
    expect(w.shouldCancelAgain(ev, 101_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(ev, 102_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(ev, 103_000)).toBeNull();
  });

  // 重取消只该收拾 Armada 自己迟到的注入(startRun 持锁 25s、injectPrompt 先 sleep
  // 1500ms 再粘贴回车,所以注入可以晚于 run.cancel 落地)。人手动重发同一段文字
  // 形状完全一样(同 cid、同 prompt、全新 generation_id),不是 Armada 该取消的东西。
  test("Armada's own late injection lands after cancel → still re-cancel", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "g-live", 100_000);
    w.noteInjection("r1");
    expect(w.shouldCancelAgain(bsp("cid-1", "g-new"), 101_600)).toBe("cid-1");
  });

  test("human resubmits same prompt after our injection slot is consumed → no re-cancel", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1");
    w.record("r1", "cid-1", "g-old", 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-ours", "hello"), 101_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(bsp("cid-1", "g-human", "hello"), 113_000)).toBeNull();
  });

  test("no injection and BSP gen is not cancel-time live → no re-cancel", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "g-live", 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-other", "hello"), 105_000)).toBeNull();
  });

  test("different prompt still re-cancels when generation identity matches", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1", "g-1");
    w.record("r1", "cid-1", undefined, 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-1", "changed"), 105_000)).toBe("cid-1");
  });

  test("after 20s window → no re-cancel", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "g-live", 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-live"), 121_000)).toBeNull();
  });

  test("unrelated hook ignored", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "g-live", 100_000);
    expect(w.shouldCancelAgain({ hook: "preToolUse", raw: { conversation_id: "cid-1", generation_id: "g-live" } }, 105_000)).toBeNull();
  });
});
