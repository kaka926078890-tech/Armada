/** Radix Dialog parks a WKWebView IME blur on the dialog shell, not on a control. */
export function focusParkedOnDialogShell(
  active: { getAttribute(name: string): string | null } | null,
): boolean {
  return active?.getAttribute("data-slot") === "dialog-content";
}
