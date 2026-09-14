import { mkdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

export function uniqueInboxFilename(sha256: string, original: string): string {
  const base = basename(original.replace(/\\/g, "/"));
  const cleaned = (base.replace(/[^\w.\u4e00-\u9fff-]+/g, "_").replace(/^\.+/, "") || "file").slice(0, 120);
  const id = sha256.replace(/[^a-fA-F0-9]/g, "").slice(0, 8) || "file";
  return `${id}-${cleaned}`;
}

export function materializeInboxFile(
  workspaceRoot: string,
  runId: string,
  filename: string,
  bytes: Buffer,
): { absPath: string; relPath: string } {
  if (!filename || filename.includes("..") || /[\\/]/.test(filename)) throw new Error("BAD_INBOX_NAME");
  const safeRun = runId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "run";
  const absPath = join(workspaceRoot, ".armada", "inbox", safeRun, filename);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, bytes);
  return { absPath, relPath: `.armada/inbox/${safeRun}/${filename}` };
}
