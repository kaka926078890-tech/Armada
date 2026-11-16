import { describe, expect, test } from "bun:test";
import { dispatchSendPlaceholder, endFollowupSend, isDispatchSendChord, isFollowupSendEnter, tryBeginFollowupSend } from "../src/followupSend";

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
      key: "Enter", shiftKey: false, isComposing: true, nativeEvent: { keyCode: 229 },
    })).toBe(false);
  });

  test("WKWebView Enter after CJK still sends even if keyCode stays 229", () => {
    expect(isFollowupSendEnter({
      key: "Enter", shiftKey: false, nativeEvent: { keyCode: 229 },
    })).toBe(true);
  });
});

describe("isDispatchSendChord", () => {
  test("default chord sends on Shift+Enter and leaves bare Enter alone", () => {
    expect(isDispatchSendChord({ key: "Enter", shiftKey: true }, "shiftEnter")).toBe(true);
    expect(isDispatchSendChord({ key: "NumpadEnter", shiftKey: true }, "shiftEnter")).toBe(true);
    expect(isDispatchSendChord({ key: "Enter", shiftKey: false }, "shiftEnter")).toBe(false);
    expect(isDispatchSendChord({ key: "a", shiftKey: true }, "shiftEnter")).toBe(false);
  });

  test("enter chord sends on bare Enter", () => {
    expect(isDispatchSendChord({ key: "Enter", shiftKey: false }, "enter")).toBe(true);
    expect(isDispatchSendChord({ key: "Enter", shiftKey: true }, "enter")).toBe(false);
  });

  test("IME composition does not send in either chord", () => {
    expect(isDispatchSendChord({ key: "Enter", shiftKey: true, isComposing: true }, "shiftEnter")).toBe(false);
    expect(isDispatchSendChord({
      key: "Enter", shiftKey: false, nativeEvent: { isComposing: true },
    }, "enter")).toBe(false);
  });

  test("placeholder matches the chord", () => {
    expect(dispatchSendPlaceholder("shiftEnter")).toContain("Shift+Enter 发送");
    expect(dispatchSendPlaceholder("enter")).toContain("Enter 发送");
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
