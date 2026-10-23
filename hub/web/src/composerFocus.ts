const CONTROL = "button, a, input, textarea, select, [contenteditable='true']";

/** WKWebView drops the caret onto body or the dialog shell. A real control is a deliberate move. */
export function shouldRestoreComposerFocus(
  active: { closest(selector: string): unknown } | null,
): boolean {
  if (!active) return true;
  return active.closest(CONTROL) == null;
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
