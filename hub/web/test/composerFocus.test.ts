import { describe, expect, test } from "bun:test";
import { focusParkedOnDialogShell } from "../src/composerFocus";

describe("focusParkedOnDialogShell", () => {
  test("dialog shell is the WKWebView IME parking spot", () => {
    expect(focusParkedOnDialogShell({ getAttribute: (name) => name === "data-slot" ? "dialog-content" : null })).toBe(true);
  });

  test("a button or an empty blur is not pulled back", () => {
    expect(focusParkedOnDialogShell(null)).toBe(false);
    expect(focusParkedOnDialogShell({ getAttribute: () => null })).toBe(false);
    expect(focusParkedOnDialogShell({ getAttribute: () => "button" })).toBe(false);
  });
});
