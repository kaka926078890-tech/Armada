import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { basename } from "path";
import { workspacePathIn } from "./workspacePath";
import {
  MAX_PATH_CHARS,
  MAX_PREVIEW_BYTES,
  PREVIEW_EXTS,
  candidatePaths,
  extOf,
  isInsideWorkspace,
  mimeForExt,
} from "./workspaceFile";

export type WorkspaceFileOk = { ok: true; path: string; name: string; mime: string; text: string };
export type WorkspaceFileErr = { ok: false; error: string };
export type WorkspaceFileResult = WorkspaceFileOk | WorkspaceFileErr;

function real(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

export function readWorkspaceFile(opts: {
  workspaceRoot: string;
  path: string;
  openWorkspaces: string[];
}): WorkspaceFileResult {
  const workspaceRoot = String(opts.workspaceRoot ?? "").trim();
  const requested = String(opts.path ?? "").trim();
  if (!workspaceRoot || !requested || requested.length > MAX_PATH_CHARS || requested.includes("\0")) {
    return { ok: false, error: "INVALID" };
  }
  if (!workspacePathIn(workspaceRoot, opts.openWorkspaces)) {
    return { ok: false, error: "WORKSPACE_NOT_OPEN" };
  }
  const rootReal = real(workspaceRoot) ?? workspaceRoot;
  let sawOutside = false;
  let sawBadType = false;
  for (const cand of candidatePaths(workspaceRoot, requested)) {
    if (!existsSync(cand)) continue;
    const abs = real(cand);
    if (!abs) continue;
    if (!isInsideWorkspace(abs, rootReal)) {
      sawOutside = true;
      continue;
    }
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    const name = basename(abs);
    const ext = extOf(name);
    if (!PREVIEW_EXTS.has(ext)) {
      sawBadType = true;
      continue;
    }
    if (st.size > MAX_PREVIEW_BYTES) return { ok: false, error: "FILE_TOO_LARGE" };
    let buf: Buffer;
    try { buf = readFileSync(abs); } catch { return { ok: false, error: "FILE_NOT_FOUND" }; }
    if (buf.includes(0)) return { ok: false, error: "FILE_NOT_TEXT" };
    return {
      ok: true,
      path: abs,
      name,
      mime: mimeForExt(ext),
      text: buf.toString("utf8"),
    };
  }
  if (sawBadType) return { ok: false, error: "FILE_NOT_TEXT" };
  if (sawOutside) return { ok: false, error: "PATH_OUTSIDE_WORKSPACE" };
  return { ok: false, error: "FILE_NOT_FOUND" };
}
