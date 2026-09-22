/**
 * Cursor/VS Code 窗口标题按官方模板切段：定位产品名 token，只在它左侧全等匹配工作区文件夹。
 * 禁止 title.includes(文件夹)，以免 `armada` 命中 `armada-test-ws`。
 * 模板：`${dirty}${activeEditorShort} - ${rootName} - [${profileName} -] ${appName} [- ${remoteName}] [- ${activeEditorState}]`
 * Mac ` — ` 与 Windows ` - ` 同一套函数；产品名右侧装饰（Untracked / Modified / 1 problem）丢弃。
 */

export type CdpTarget = {
  type?: string;
  title?: unknown;
  webSocketDebuggerUrl?: unknown;
};

export type PickCdpPage =
  | { ok: true; wsUrl: string }
  | { ok: false; reason: "WINDOW_TARGET_NOT_FOUND" | "WINDOW_TARGET_AMBIGUOUS" | "NO_WS_URL" };

function splitTitleSegments(title: string): string[] {
  const t = title.replace(/^[●•]\s*/, "").trim();
  if (!t) return [];
  return t.split(/ — | - /);
}

/** 从右找产品名（先长后短）。`Cursor Agents` 无分隔符是一个 token，不等于 Cursor。 */
function findProductRange(parts: string[]): { start: number; end: number } | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "Visual Studio Code") return { start: i, end: i };
    if (parts[i] === "Insiders" && i >= 1 && parts[i - 1] === "Code") return { start: i - 1, end: i };
    if (parts[i] === "OSS" && i >= 1 && parts[i - 1] === "Code") return { start: i - 1, end: i };
    if (parts[i] === "Cursor") return { start: i, end: i };
  }
  return null;
}

export function workspaceFolderName(workspaceRoot: string): string {
  return workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot;
}

export function titleMatchesWorkspace(title: string, folder: string): boolean {
  if (!folder) return false;
  const trimmed = title.trim();
  const workspaceTitle = /^(.*) \(Workspace\)$/.exec(trimmed);
  if (workspaceTitle && workspaceTitle[1] === folder) return true;
  const parts = splitTitleSegments(trimmed);
  if (!parts.length) return false;
  const product = findProductRange(parts);
  if (!product) return parts[parts.length - 1] === folder;
  const before = parts.slice(0, product.start);
  if (!before.length) return false;
  if (before[before.length - 1] === folder) return true;
  if (before.length >= 3 && before[before.length - 2] === folder) return true;
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
