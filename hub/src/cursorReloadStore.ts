import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "./writeFileAtomic";
import {
  PENDING_RELOAD_NAME,
  parsePendingReload,
  pendingFromAction,
  reloadStillNeededForFleet,
  neededReloadMachineIds,
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

export function cursorReloadView(home: string, machines: ReloadMachine[]): {
  pending: PendingReload | null;
  needed: boolean;
  neededMachineIds: string[];
} {
  const pending = readPendingReload(home);
  return {
    pending,
    needed: reloadStillNeededForFleet(pending, machines),
    neededMachineIds: neededReloadMachineIds(pending, machines, REQUIRED_EXTENSION_VERSION),
  };
}
