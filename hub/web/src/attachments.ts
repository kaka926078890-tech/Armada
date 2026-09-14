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
