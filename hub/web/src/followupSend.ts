export type FollowupSendKey = {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

export function isFollowupSendEnter(e: FollowupSendKey): boolean {
  if (e.key !== "Enter" && e.key !== "NumpadEnter") return false;
  if (e.shiftKey) return false;
  // Only block while the IME candidate window is open. WKWebView often keeps
  // keyCode 229 after 中文上屏; treating that as composition made Enter insert
  // a newline in the new-task modal instead of dispatching.
  if (e.isComposing || e.nativeEvent?.isComposing) return false;
  return true;
}

export function tryBeginFollowupSend(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function endFollowupSend(lock: { current: boolean }): void {
  lock.current = false;
}
