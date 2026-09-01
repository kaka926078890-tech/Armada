export const DESKTOP_BOARD_SOURCE = "armada-desktop";

export type DesktopBoardRequest = "open-workspace" | "get-share-link" | "leave-fleet";

export function requestDesktop(type: DesktopBoardRequest): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ source: DESKTOP_BOARD_SOURCE, type }, "*");
}
