import { mkdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

function safeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "run";
}

/**
 * `@` 菜单按文件名全等，不看目录。内容哈希只区分不同文件；
 * 同一份附件再挂到另一个 run 时，文件名必须不同，否则两行同名会被拒。
 */
export function uniqueInboxFilename(sha256: string, runId: string, original: string): string {
  const base = basename(original.replace(/\\/g, "/"));
  const cleaned = (base.replace(/[^\w.\u4e00-\u9fff-]+/g, "_").replace(/^\.+/, "") || "file").slice(0, 120);
  const id = sha256.replace(/[^a-fA-F0-9]/g, "").slice(0, 8) || "file";
  return `${id}-${safeRunId(runId)}-${cleaned}`;
}

export function materializeInboxFile(
  workspaceRoot: string,
  runId: string,
  filename: string,
  bytes: Buffer,
): { absPath: string; relPath: string } {
  if (!filename || filename.includes("..") || /[\\/]/.test(filename)) throw new Error("BAD_INBOX_NAME");
  const safeRun = safeRunId(runId);
  const absPath = join(workspaceRoot, ".armada", "inbox", safeRun, filename);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, bytes);
  return { absPath, relPath: `.armada/inbox/${safeRun}/${filename}` };
}
