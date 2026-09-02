export const MAX_CONSOLE_ATTACHMENTS = 4;

export function isConsoleImage(file: File): boolean {
  return file.type === "image/png" || file.type === "image/jpeg";
}

/** 控制台选图/粘贴：第 5 张起列表拒收。 */
export function mergeImageFiles(prev: File[], incoming: File[]): { files: File[]; rejected: number } {
  const ok = incoming.filter(isConsoleImage);
  const next = [...prev, ...ok];
  const files = next.slice(0, MAX_CONSOLE_ATTACHMENTS);
  return { files, rejected: next.length - files.length };
}
