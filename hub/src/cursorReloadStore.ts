import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  PENDING_RELOAD_NAME,
  parsePendingReload,
  pendingFromAction,
  reloadStillNeeded,
  type CursorReloadAction,
  type PendingReload,
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
): PendingReload | null {
  const p = pendingReloadPath(home);
  if (action === "skip") {
    try { unlinkSync(p); } catch { /* missing */ }
    return null;
  }
  const next = pendingFromAction(action, vsix || REQUIRED_EXTENSION_VERSION, now, notBefore);
  if (!next) return null;
  writeFileSync(p, JSON.stringify(next), { mode: 0o600 });
  return next;
}

export function cursorReloadView(home: string, installed: Array<string | null | undefined>): {
  pending: PendingReload | null;
  needed: boolean;
} {
  const pending = readPendingReload(home);
  return { pending, needed: reloadStillNeeded(pending, installed) };
}
