export const MAX_CONSOLE_ATTACHMENTS = 32;

export const CONSOLE_FILE_EXTS = [
  "pdf", "txt", "md", "json", "csv", "xml", "yaml", "yml", "html", "htm", "log",
  "zip", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
] as const;

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

/** 控制台选附件/粘贴：超过个数的丢掉。不支持的类型单独计数，不占个数。 */
export function mergeAttachmentFiles(prev: File[], incoming: File[], max = MAX_CONSOLE_ATTACHMENTS): { files: File[]; rejected: number; unsupported: number } {
  const cap = Number.isInteger(max) && max > 0 ? max : MAX_CONSOLE_ATTACHMENTS;
  const ok = incoming.filter(isConsoleAttachment);
  const next = [...prev, ...ok];
  const files = next.slice(0, cap);
  return { files, rejected: next.length - files.length, unsupported: incoming.length - ok.length };
}

export function attachmentLimitMessage(max: number): string {
  return `最多 ${max} 个附件，已忽略多余文件`;
}

export function attachmentUnsupportedMessage(): string {
  return "不支持的文件类型";
}

export function attachmentPickMessage(rejected: number, unsupported: number, max: number): string {
  const parts: string[] = [];
  if (unsupported) parts.push(attachmentUnsupportedMessage());
  if (rejected) parts.push(attachmentLimitMessage(max));
  return parts.join("。");
}

export function uploadErrorMessage(error: string | undefined): string | null {
  if (error === "ATTACHMENT_TOO_LARGE") return "单个文件超过大小上限";
  if (error === "ATTACHMENT_TOTAL_TOO_LARGE") return "这次附件合计超过大小上限";
  if (error === "ATTACHMENT_INVALID_MIME") return attachmentUnsupportedMessage();
  return null;
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

export function parseRunAttachmentIds(raw: string | null | undefined): string[] {
  try {
    const p = JSON.parse(raw || "[]");
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  } catch {
    return [];
  }
}
