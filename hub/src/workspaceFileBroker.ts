import { randomBytes } from "crypto";
import { cmpSemver } from "../../desktop-core/src/cursorReload";
import { FILE_VIEW_MIN_EXT, MAX_PATH_CHARS } from "../../extension/src/workspaceFile";
import type { Registry } from "./registry";

export const FILE_READ_TIMEOUT_MS = 8_000;

export type WorkspaceFileOk = { ok: true; path: string; name: string; mime: string; text: string };
export type WorkspaceFileErr = { ok: false; error: string };
export type WorkspaceFileResult = WorkspaceFileOk | WorkspaceFileErr;

export function fileHttpStatus(error: string): 400 | 404 | 409 | 413 | 502 {
  if (error === "FILE_READ_TIMEOUT") return 502;
  if (error === "FILE_TOO_LARGE") return 413;
  if (error === "FILE_NOT_FOUND" || error === "NOT_FOUND") return 404;
  if (error === "FILE_VIEW_UNSUPPORTED") return 409;
  return 400;
}

export class WorkspaceFileBroker {
  private pending = new Map<string, {
    resolve: (r: WorkspaceFileResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private timeoutMs = FILE_READ_TIMEOUT_MS) {}

  onReply(msg: any): boolean {
    const id = typeof msg?.requestId === "string" ? msg.requestId : "";
    const wait = this.pending.get(id);
    if (!wait) return false;
    this.pending.delete(id);
    clearTimeout(wait.timer);
    if (msg.ok === true && typeof msg.text === "string") {
      wait.resolve({
        ok: true,
        path: String(msg.path ?? ""),
        name: String(msg.name ?? ""),
        mime: String(msg.mime ?? "text/plain"),
        text: msg.text,
      });
    } else {
      const error = typeof msg.error === "string" && msg.error ? msg.error : "FILE_READ_TIMEOUT";
      wait.resolve({ ok: false, error });
    }
    return true;
  }

  request(opts: {
    registry: Registry;
    machineId: string;
    workspaceRoot: string;
    path: string;
  }): Promise<WorkspaceFileResult> {
    const path = String(opts.path ?? "").trim();
    if (!path || path.length > MAX_PATH_CHARS || path.includes("\0")) {
      return Promise.resolve({ ok: false, error: "INVALID" });
    }
    const win = opts.registry.findWindowForWorkspace(opts.machineId, opts.workspaceRoot);
    if (!win) {
      return Promise.resolve({
        ok: false,
        error: opts.registry.isMachineConnected(opts.machineId) ? "WORKSPACE_NOT_OPEN" : "MACHINE_OFFLINE",
      });
    }
    const ver = opts.registry.windowExtensionVersion(win.machineId, win.windowId);
    if (!ver || cmpSemver(ver, FILE_VIEW_MIN_EXT) < 0) {
      return Promise.resolve({ ok: false, error: "FILE_VIEW_UNSUPPORTED" });
    }
    const requestId = randomBytes(8).toString("hex");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: "FILE_READ_TIMEOUT" });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      const sent = opts.registry.sendTo(win.machineId, win.windowId, {
        type: "workspace.readFile",
        requestId,
        workspaceRoot: opts.workspaceRoot,
        path,
      });
      if (!sent) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        resolve({ ok: false, error: "MACHINE_OFFLINE" });
      }
    });
  }

  dispose(): void {
    for (const wait of this.pending.values()) {
      clearTimeout(wait.timer);
      wait.resolve({ ok: false, error: "FILE_READ_TIMEOUT" });
    }
    this.pending.clear();
  }
}
