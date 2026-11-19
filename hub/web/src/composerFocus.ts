const CONTROL = "button, a, input, textarea, select, [contenteditable='true']";
/** Fields take the pointer for themselves. Links stay selectable: a drag often starts on an anchor. */
const FIELD = "button, input, textarea, select, [contenteditable='true']";
const COPY_ROOT = "[data-armada-copy]";

/** WKWebView drops the caret onto body or the dialog shell. A real control is a deliberate move. */
export function shouldRestoreComposerFocus(
  active: { closest(selector: string): unknown } | null,
): boolean {
  if (!active) return true;
  return active.closest(CONTROL) == null;
}

export function isSelectableCopyTarget(
  target: { closest(selector: string): unknown } | null,
): boolean {
  if (!target) return false;
  if (target.closest(FIELD) != null) return false;
  return target.closest(COPY_ROOT) != null;
}

let pendingSelectablePointer = false;

/** Pointer went down on detail text. Call before blurring the composer. */
export function noteSelectablePointerDown(
  target: { closest(selector: string): unknown } | null,
): void {
  if (!isSelectableCopyTarget(target)) return;
  pendingSelectablePointer = true;
  if (typeof window === "undefined") return;
  const clear = () => { pendingSelectablePointer = false; };
  window.addEventListener("pointerup", clear, { capture: true, once: true });
  window.addEventListener("pointercancel", clear, { capture: true, once: true });
}

/**
 * True only for the blur caused by that pointer.
 * Restoring the caret afterwards clears the drag selection.
 */
export function takeSelectablePointerBlur(): boolean {
  const hit = pendingSelectablePointer;
  pendingSelectablePointer = false;
  return hit;
}

/**
 * Drop focus in the same pointerdown that starts a drag.
 * WKWebView otherwise keeps the composer focused and never begins the selection.
 */
export function releaseFieldForTextSelection(
  active: { closest(selector: string): unknown; blur(): void } | null,
  target: { closest(selector: string): unknown } | null,
): void {
  noteSelectablePointerDown(target);
  if (!isSelectableCopyTarget(target)) return;
  if (!active || active.closest("textarea, input") == null) return;
  active.blur();
}

/**
 * After Enter/发送, WebKit parks the caret on the submit button, then disabling
 * that button drops it. Another text field is the operator moving on.
 */
export function shouldRefocusComposerAfterSend(
  active: { closest(selector: string): unknown; getAttribute?(name: string): string | null } | null,
  sendButton: unknown | null,
): boolean {
  if (sendButton != null && active === sendButton) return true;
  if (active?.getAttribute?.("data-armada-send") != null) return true;
  return shouldRestoreComposerFocus(active);
}

export function queueComposerCaretRestore(
  el: { isConnected: boolean; focus(): void; ownerDocument: { activeElement: unknown } },
  decide: (active: Element | null) => boolean = (active) => shouldRestoreComposerFocus(active),
): void {
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    const active = el.ownerDocument.activeElement;
    if (active === el) return;
    if (decide(active instanceof Element ? active : null)) el.focus();
  });
}
