import { describe, expect, test } from "bun:test";
import { shouldRefocusComposerAfterSend, shouldRestoreComposerFocus } from "../src/composerFocus";

const shell = { closest: () => null };
const button = { closest: (sel: string) => sel.includes("button") ? {} : null };

describe("shouldRestoreComposerFocus", () => {
  test("body and the dialog shell get the caret back", () => {
    expect(shouldRestoreComposerFocus(null)).toBe(true);
    expect(shouldRestoreComposerFocus(shell)).toBe(true);
  });

  test("a button or field is left alone", () => {
    expect(shouldRestoreComposerFocus(button)).toBe(false);
  });

  test("after send, the submit button gives the caret back and another field does not", () => {
    const send = { closest: () => ({}) };
    const other = { closest: (sel: string) => (sel.includes("textarea") ? {} : null) };
    expect(shouldRefocusComposerAfterSend(null, send)).toBe(true);
    expect(shouldRefocusComposerAfterSend(send, send)).toBe(true);
    expect(shouldRefocusComposerAfterSend(shell, send)).toBe(true);
    expect(shouldRefocusComposerAfterSend(button, send)).toBe(false);
    expect(shouldRefocusComposerAfterSend(other, send)).toBe(false);
    const marked = { closest: () => ({}), getAttribute: (name: string) => (name === "data-armada-send" ? "" : null) };
    expect(shouldRefocusComposerAfterSend(marked, null)).toBe(true);
  });
});
