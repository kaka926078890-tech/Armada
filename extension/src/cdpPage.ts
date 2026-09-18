/**
 * Cursor/VS Code 窗口标题：`file — folder`、Windows `file - folder - Cursor`、或文件夹名。
 * 禁止 title.includes(文件夹)，以免 `armada` 命中 `armada-test-ws`。
 * Windows 真机 2026-09-18：CDP title 末段是应用名 `Cursor`，先剥一层再取文件夹段。
 */

export type CdpTarget = {
  type?: string;
  title?: unknown;
  webSocketDebuggerUrl?: unknown;
};

export type PickCdpPage =
  | { ok: true; wsUrl: string }
  | { ok: false; reason: "WINDOW_TARGET_NOT_FOUND" | "WINDOW_TARGET_AMBIGUOUS" | "NO_WS_URL" };

const APP_SUFFIXES = [" — Cursor", " - Cursor"] as const;

function stripAppSuffix(title: string): string {
  for (const suffix of APP_SUFFIXES) {
    if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trimEnd();
  }
  return title;
}

export function workspaceFolderName(workspaceRoot: string): string {
  return workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot;
}

export function titleMatchesWorkspace(title: string, folder: string): boolean {
  if (!folder) return false;
  const t = stripAppSuffix(title.trim());
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
