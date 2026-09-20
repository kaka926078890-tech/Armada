import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";

/** Config files: write tmp then rename so a crash cannot leave a half JSON. */
export function writeFileAtomic(path: string, data: string | NodeJS.ArrayBufferView, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    try {
      renameSync(tmp, path);
    } catch {
      unlinkSync(path);
      renameSync(tmp, path);
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}
