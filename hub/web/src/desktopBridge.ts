export const DESKTOP_BOARD_SOURCE = "armada-desktop";
export const DESKTOP_HOST_SOURCE = "armada-desktop-host";

export type DesktopBoardCommand = "open-workspace" | "get-share-link" | "leave-fleet";

export type DesktopRunAlert = {
  runId: string;
  machineId: string;
  workspaceRoot: string;
  title: string;
  body: string;
};

export type HostOpenRun = {
  runId: string;
  machineId: string;
  workspaceRoot: string;
};

export function requestDesktop(type: DesktopBoardCommand): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ source: DESKTOP_BOARD_SOURCE, type }, "*");
}

export function requestDesktopAlert(alert: DesktopRunAlert): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ source: DESKTOP_BOARD_SOURCE, type: "run.alert", ...alert }, "*");
}

export function parseHostOpenRun(
  data: unknown,
  eventSource: MessageEvent["source"],
  parent: Window | null,
): HostOpenRun | null {
  if (!parent || eventSource !== parent) return null;
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.source !== DESKTOP_HOST_SOURCE || o.type !== "open-run") return null;
  if (
    typeof o.runId !== "string" || !o.runId
    || typeof o.machineId !== "string" || !o.machineId
    || typeof o.workspaceRoot !== "string" || !o.workspaceRoot
  ) return null;
  return { runId: o.runId, machineId: o.machineId, workspaceRoot: o.workspaceRoot };
}
