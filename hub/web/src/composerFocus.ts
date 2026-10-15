const CONTROL = "button, a, input, textarea, select, [contenteditable='true']";

/** WKWebView drops the caret onto body or the dialog shell. A real control is a deliberate move. */
export function shouldRestoreComposerFocus(
  active: { closest(selector: string): unknown } | null,
): boolean {
  if (!active) return true;
  return active.closest(CONTROL) == null;
}
