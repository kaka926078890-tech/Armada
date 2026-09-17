/** Cursor/VS Code 窗口标题：`file — folder` 或文件夹名。禁止 title.includes(文件夹)，以免 `armada` 命中 `armada-test-ws`。 */

export type CdpTarget = {
  type?: string;
  title?: unknown;
  webSocketDebuggerUrl?: unknown;
};

export type PickCdpPage =
  | { ok: true; wsUrl: string }
  | { ok: false; reason: "WINDOW_TARGET_NOT_FOUND" | "WINDOW_TARGET_AMBIGUOUS" | "NO_WS_URL" };

export function workspaceFolderName(workspaceRoot: string): string {
  return workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot;
}

export function titleMatchesWorkspace(title: string, folder: string): boolean {
  if (!folder) return false;
  const t = title.trim();
  if (t === folder) return true;
  for (const sep of [" — ", " - "]) {
    const i = t.lastIndexOf(sep);
    if (i >= 0 && t.slice(i + sep.length).trim() === folder) return true;
  }
  return false;
}

export function pickCdpPage(targets: CdpTarget[], workspaceRoot: string): PickCdpPage {
  const folder = workspaceFolderName(workspaceRoot);
  const pages = targets.filter(
    (t) => t.type === "page" && typeof t.title === "string" && titleMatchesWorkspace(t.title, folder),
  );
  if (pages.length === 0) return { ok: false, reason: "WINDOW_TARGET_NOT_FOUND" };
  if (pages.length > 1) return { ok: false, reason: "WINDOW_TARGET_AMBIGUOUS" };
  const wsUrl = pages[0]?.webSocketDebuggerUrl;
  if (typeof wsUrl !== "string" || !wsUrl) return { ok: false, reason: "NO_WS_URL" };
  return { ok: true, wsUrl };
}
