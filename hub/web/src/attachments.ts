export const MAX_CONSOLE_ATTACHMENTS = 4;

export const CONSOLE_FILE_EXTS = ["pdf", "txt", "md", "json", "csv", "xml", "yaml", "yml", "html", "htm", "log"] as const;

export const CONSOLE_ACCEPT = ["image/png", "image/jpeg", ...CONSOLE_FILE_EXTS.map((e) => `.${e}`)].join(",");

export function isConsoleImage(file: File): boolean {
  return file.type === "image/png" || file.type === "image/jpeg";
}

export function isConsoleAttachment(file: File): boolean {
  if (isConsoleImage(file)) return true;
  const name = file.name || "";
  const i = name.lastIndexOf(".");
  const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  return (CONSOLE_FILE_EXTS as readonly string[]).includes(ext);
}

/** 控制台选附件/粘贴：第 5 个起列表拒收。非法类型忽略，不计入 rejected。 */
export function mergeAttachmentFiles(prev: File[], incoming: File[]): { files: File[]; rejected: number } {
  const ok = incoming.filter(isConsoleAttachment);
  const next = [...prev, ...ok];
  const files = next.slice(0, MAX_CONSOLE_ATTACHMENTS);
  return { files, rejected: next.length - files.length };
}

export const mergeImageFiles = mergeAttachmentFiles;

/** 列表展示上限；完整名走 title。CSS truncate 仍要 min-w-0，这条防止原生控件把对话框撑出横条。 */
export const ATTACHMENT_NAME_DISPLAY_MAX = 36;

export function displayAttachmentName(name: string, max = ATTACHMENT_NAME_DISPLAY_MAX): string {
  const raw = name.trim() || "粘贴的图片";
  if (raw.length <= max) return raw;
  const dot = raw.lastIndexOf(".");
  const ext = dot > 0 && raw.length - dot <= 8 && raw.length - dot > 1 ? raw.slice(dot) : "";
  const budget = max - ext.length - 1;
  if (budget < 4) return `${raw.slice(0, Math.max(1, max - 1))}…`;
  return `${raw.slice(0, budget)}…${ext}`;
}
