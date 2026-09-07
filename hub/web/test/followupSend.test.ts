import { describe, expect, test } from "bun:test";
import { endFollowupSend, isFollowupSendEnter, tryBeginFollowupSend } from "../src/followupSend";

describe("isFollowupSendEnter", () => {
  test("Enter sends; Shift+Enter does not", () => {
    expect(isFollowupSendEnter({ key: "Enter", shiftKey: false })).toBe(true);
    expect(isFollowupSendEnter({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isFollowupSendEnter({ key: "a", shiftKey: false })).toBe(false);
  });

  test("IME composition Enter does not send (Chinese confirm)", () => {
    expect(isFollowupSendEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isFollowupSendEnter({
      key: "Enter", shiftKey: false, nativeEvent: { isComposing: true },
    })).toBe(false);
    expect(isFollowupSendEnter({
      key: "Enter", shiftKey: false, nativeEvent: { keyCode: 229 },
    })).toBe(false);
  });
});

describe("tryBeginFollowupSend", () => {
  test("second call while in-flight is ignored", () => {
    const lock = { current: false };
    expect(tryBeginFollowupSend(lock)).toBe(true);
    expect(tryBeginFollowupSend(lock)).toBe(false);
    endFollowupSend(lock);
    expect(tryBeginFollowupSend(lock)).toBe(true);
  });
});
