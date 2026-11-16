import type { DispatchSendChord } from "./uiPrefs";

export type FollowupSendKey = {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

/** 派发框。默认 Shift+Enter 发送，裸 Enter 留给换行和输入法上屏。 */
export function isDispatchSendChord(e: FollowupSendKey, chord: DispatchSendChord): boolean {
  if (e.key !== "Enter" && e.key !== "NumpadEnter") return false;
  if (e.isComposing || e.nativeEvent?.isComposing) return false;
  return chord === "shiftEnter" ? e.shiftKey : !e.shiftKey;
}

export function dispatchSendPlaceholder(chord: DispatchSendChord): string {
  return chord === "shiftEnter"
    ? "写下要做的事。Shift+Enter 发送，Enter 换行"
    : "写下要做的事。Enter 发送，Shift+Enter 换行";
}

export function isFollowupSendEnter(e: FollowupSendKey): boolean {
  if (e.key !== "Enter" && e.key !== "NumpadEnter") return false;
  if (e.shiftKey) return false;
  // Only block while the IME candidate window is open. WKWebView often keeps
  // keyCode 229 after 中文上屏; treating that as composition made Enter insert
  // a newline instead of sending the follow-up.
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
