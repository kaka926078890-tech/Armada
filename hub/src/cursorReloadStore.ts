import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "./writeFileAtomic";
import {
  PENDING_RELOAD_NAME,
  parsePendingReload,
  pendingFromAction,
  reloadStillNeededForFleet,
  neededReloadMachineIds,
  vsixFileName,
  vsixPackMissingNotice,
  type CursorReloadAction,
  type PendingReload,
  type ReloadMachine,
} from "../../desktop-core/src/cursorReload";
import { REQUIRED_EXTENSION_VERSION } from "../web/src/boardState";

export function pendingReloadPath(home: string): string {
  return join(home, PENDING_RELOAD_NAME);
}

export function readPendingReload(home: string): PendingReload | null {
  const p = pendingReloadPath(home);
  if (!existsSync(p)) return null;
  try {
    return parsePendingReload(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

export function writePendingReload(
  home: string,
  action: CursorReloadAction,
  vsix: string,
  now: number,
  notBefore?: number,
  machineId?: string,
): PendingReload | null {
  const p = pendingReloadPath(home);
  if (action === "skip") {
    const cur = readPendingReload(home);
    if (machineId) {
      if (cur?.machineId === machineId) {
        try { unlinkSync(p); } catch { /* missing */ }
        return null;
      }
      return cur;
    }
    try { unlinkSync(p); } catch { /* missing */ }
    return null;
  }
  const next = pendingFromAction(action, vsix || REQUIRED_EXTENSION_VERSION, now, notBefore, machineId);
  if (!next) return null;
  writeFileAtomic(p, JSON.stringify(next), 0o600);
  return next;
}

export function vsixPackSearchDirs(cwd: string): string[] {
  return [join(cwd, ".."), join(cwd, "..", "extension"), join(cwd, "extension")];
}

export function findVsixPack(version: string, searchDirs: string[]): string | null {
  const name = vsixFileName(version);
  if (!name) return null;
  for (const dir of searchDirs) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function cursorReloadView(home: string, machines: ReloadMachine[], packPresent = true): {
  pending: PendingReload | null;
  needed: boolean;
  neededMachineIds: string[];
  required: string;
  packPresent: boolean;
  notice: string | null;
} {
  const pending = readPendingReload(home);
  const required = REQUIRED_EXTENSION_VERSION;
  if (!packPresent) {
    return {
      pending,
      needed: false,
      neededMachineIds: [],
      required,
      packPresent: false,
      notice: vsixPackMissingNotice(required),
    };
  }
  const neededMachineIds = neededReloadMachineIds(pending, machines, required);
  return {
    pending,
    needed: neededMachineIds.length > 0 || reloadStillNeededForFleet(pending, machines),
    neededMachineIds,
    required,
    packPresent: true,
    notice: null,
  };
}
