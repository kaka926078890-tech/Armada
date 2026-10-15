import { describe, expect, test } from "bun:test";
import { shouldRestoreComposerFocus } from "../src/composerFocus";

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
});
