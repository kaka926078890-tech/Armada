export type FollowupSendKey = {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

export function isFollowupSendEnter(e: FollowupSendKey): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  if (e.isComposing || e.nativeEvent?.isComposing) return false;
  if (e.nativeEvent?.keyCode === 229) return false;
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
