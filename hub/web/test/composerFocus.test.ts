import { describe, expect, test } from "bun:test";
import {
  isSelectableCopyTarget,
  noteSelectablePointerDown,
  releaseFieldForTextSelection,
  shouldRefocusComposerAfterSend,
  shouldRestoreComposerFocus,
  takeSelectablePointerBlur,
} from "../src/composerFocus";

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

const transcript = {
  closest: (sel: string) => (sel.includes("data-armada-copy") ? {} : null),
};
const copyButton = {
  closest: (sel: string) => (sel.includes("button") || sel.includes("data-armada-copy") ? {} : null),
};

describe("detail text selection", () => {
  test("transcript text is selectable and a button inside it is not", () => {
    expect(isSelectableCopyTarget(transcript)).toBe(true);
    expect(isSelectableCopyTarget(copyButton)).toBe(false);
    expect(isSelectableCopyTarget({ closest: () => null })).toBe(false);
    expect(isSelectableCopyTarget(null)).toBe(false);
  });

  test("a pointer on transcript text is consumed by that blur only", () => {
    expect(takeSelectablePointerBlur()).toBe(false);
    noteSelectablePointerDown({ closest: () => null });
    expect(takeSelectablePointerBlur()).toBe(false);
    noteSelectablePointerDown(transcript);
    expect(takeSelectablePointerBlur()).toBe(true);
    expect(takeSelectablePointerBlur()).toBe(false);
  });

  test("the composer blurs after the gesture is marked, so the blur can decline caret restore", () => {
    let seen = false;
    const field = {
      closest: (sel: string) => (sel.includes("textarea") ? {} : null),
      blur: () => { seen = takeSelectablePointerBlur(); },
    };
    releaseFieldForTextSelection(field, transcript);
    expect(seen).toBe(true);
    releaseFieldForTextSelection(field, copyButton);
    expect(takeSelectablePointerBlur()).toBe(false);
  });
});
