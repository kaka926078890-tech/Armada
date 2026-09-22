import { normalizeWorkspacePath } from "./workspacePath";

export const PREVIEW_EXTS = new Set([
  "md", "markdown", "txt", "json", "csv", "xml", "yaml", "yml", "html", "htm", "log", "toml",
]);

export const MAX_PREVIEW_BYTES = 512 * 1024;
export const MAX_PATH_CHARS = 2048;
export const FILE_VIEW_MIN_EXT = "0.4.44";
export const ARMADA_FILE_SCHEME = "armada-file";

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i + 1).toLowerCase();
}

export function mimeForExt(ext: string): string {
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "json") return "application/json";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "csv") return "text/csv";
  if (ext === "xml") return "application/xml";
  if (ext === "yaml" || ext === "yml") return "text/yaml";
  return "text/plain";
}

export function isAbsolutePath(p: string): boolean {
  const s = p.replace(/\\/g, "/");
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s);
}

export function decodeFileHref(href: string): string {
  let s = href.trim();
  if (!s) return "";
  if (/^armada-file:/i.test(s)) {
    const q = s.match(/[?&]p=([^&]*)/);
    if (q) {
      try { return decodeURIComponent(q[1] ?? ""); } catch { return q[1] ?? ""; }
    }
  }
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/\//i, "");
    try { s = decodeURIComponent(s); } catch { /* keep */ }
    if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
    return s;
  }
  try { return decodeURIComponent(s); } catch { return s; }
}

export function looksLikeWorkspaceFileHref(href: string): boolean {
  const t = href.trim();
  if (!t) return false;
  if (/^(https?:|mailto:|tel:|data:|#)/i.test(t)) return false;
  const path = decodeFileHref(t);
  return PREVIEW_EXTS.has(extOf(path));
}

export function armadaFileHref(path: string): string {
  return `${ARMADA_FILE_SCHEME}://preview?p=${encodeURIComponent(path)}`;
}

export function workspaceFilePathFromHref(href: string | undefined | null): string | null {
  if (typeof href !== "string" || !looksLikeWorkspaceFileHref(href)) return null;
  const path = decodeFileHref(href).trim();
  return path && path.length <= MAX_PATH_CHARS ? path : null;
}

export function candidatePaths(workspaceRoot: string, requested: string): string[] {
  const req = requested.replace(/\\/g, "/").replace(/^\.\//, "");
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const out: string[] = [];
  const push = (p: string) => { if (p && !out.includes(p)) out.push(p); };
  if (isAbsolutePath(req)) {
    push(req);
    return out;
  }
  const rel = req.replace(/^\//, "");
  if (rel) push(`${root}/${rel}`);
  const folder = root.split("/").filter(Boolean).at(-1) ?? "";
  if (folder && (rel === folder || rel.startsWith(`${folder}/`))) {
    const stripped = rel.slice(folder.length).replace(/^\//, "");
    push(stripped ? `${root}/${stripped}` : root);
  }
  return out;
}

export function isInsideWorkspace(abs: string, workspaceRoot: string): boolean {
  const a = normalizeWorkspacePath(abs);
  const r = normalizeWorkspacePath(workspaceRoot);
  return a === r || a.startsWith(`${r}/`);
}

export function workspaceFileOperatorCopy(code: string): string {
  switch (code) {
    case "FILE_NOT_FOUND": return "文件不存在";
    case "PATH_OUTSIDE_WORKSPACE": return "只能查看该工作区内的文件";
    case "FILE_TOO_LARGE": return "文件太大，无法预览";
    case "FILE_NOT_TEXT": return "这不是可预览的文本";
    case "FILE_READ_TIMEOUT": return "读取超时，请确认被控机在线且已装最新扩展";
    case "FILE_VIEW_UNSUPPORTED": return "被控扩展太旧，请升级后再查看文件";
    case "MACHINE_OFFLINE": return "机器离线";
    case "WORKSPACE_NOT_OPEN": return "工作区没有打开";
    case "NOT_FOUND": return "任务不存在";
    case "INVALID": return "路径无效";
    default: return code;
  }
}
