import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export const HOOK_EVENTS = [
  "sessionStart", "sessionEnd", "beforeSubmitPrompt", "preToolUse", "postToolUse",
  "postToolUseFailure", "beforeShellExecution", "afterShellExecution", "afterFileEdit",
  "afterAgentResponse", "afterAgentThought", "subagentStart", "subagentStop",
  "preCompact", "stop",
] as const;

export function spoolScriptName(platform: string = process.platform): string {
  return platform === "win32" ? "armada-spool.exe" : "armada-spool.sh";
}

export function isArmadaSpoolCommand(command: string): boolean {
  return command.includes("armada-spool.sh")
    || command.includes("armada-spool.ps1")
    || command.includes("armada-spool.exe");
}

/** Cursor Windows hook runner is PowerShell (`$input | & { $input | & command }`). */
export function toWinHookPath(scriptPath: string): string {
  return scriptPath.replace(/\//g, "\\");
}

/** Only for POSIX `sh` commands. `C:\foo` / `C:/foo` → `/c/foo`. */
export function toBashHookPath(scriptPath: string): string {
  const n = scriptPath.replace(/\\/g, "/");
  const m = /^([A-Za-z]):\/(.*)$/.exec(n);
  if (m) return `/${m[1]!.toLowerCase()}/${m[2]}`;
  return n;
}

export function findCscExe(windir: string = process.env.WINDIR || "C:\\Windows"): string | null {
  for (const parts of [
    ["Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"],
    ["Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"],
  ] as const) {
    const p = join(windir, ...parts);
    if (existsSync(p)) return p;
  }
  return null;
}

export function compileWindowsSpooler(csPath: string, exePath: string): { ok: boolean; detail: string } {
  const csc = findCscExe();
  if (!csc) return { ok: false, detail: "csc.exe not found" };
  const r = spawnSync(csc, ["-nologo", `-out:${exePath}`, csPath], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  if (r.status !== 0) return { ok: false, detail: String(r.stderr || r.stdout || r.status) };
  return { ok: true, detail: exePath };
}

export function hookCommand(scriptPath: string, event: string): string {
  const unixy = scriptPath.replace(/\\/g, "/");
  if (unixy.toLowerCase().endsWith(".exe") || unixy.toLowerCase().endsWith(".ps1")) {
    return `"${toWinHookPath(scriptPath)}" ${event}`;
  }
  if (/^[A-Za-z]:\//.test(unixy)) {
    return `sh "${toBashHookPath(scriptPath)}" ${event}`;
  }
  return `${scriptPath} ${event}`;
}

/** Windows Cursor wraps every hook in a new PowerShell that cannot reliably finish in 5s. */
export function shouldInstallArmadaHooks(scriptPath: string): boolean {
  const unixy = scriptPath.replace(/\\/g, "/").toLowerCase();
  return !unixy.endsWith(".exe") && !unixy.endsWith(".ps1");
}

export function mergeHooks(existing: any, scriptPath: string): { merged: any; changed: boolean } {
  const merged = existing && typeof existing === "object" ? JSON.parse(JSON.stringify(existing)) : { version: 1 };
  if (!merged.hooks || typeof merged.hooks !== "object") merged.hooks = {};
  let changed = false;
  const install = shouldInstallArmadaHooks(scriptPath);
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(merged.hooks[event])) merged.hooks[event] = [];
    const lst = merged.hooks[event] as any[];
    const rest = lst.filter((e) => !(typeof e?.command === "string" && isArmadaSpoolCommand(e.command)));
    const ours = lst.filter((e) => typeof e?.command === "string" && isArmadaSpoolCommand(e.command));
    if (!install) {
      if (ours.length > 0) {
        merged.hooks[event] = rest;
        changed = true;
      }
      continue;
    }
    const expected = { command: hookCommand(scriptPath, event), timeout: 5 };
    const same = ours.length === 1 && ours[0].command === expected.command && ours[0].timeout === expected.timeout;
    if (!same) {
      merged.hooks[event] = [...rest, expected];
      changed = true;
    }
  }
  return { merged, changed };
}

export function hooksDriftHash(existing: any): string {
  const ours: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    const lst = Array.isArray(existing?.hooks?.[event]) ? existing.hooks[event] : [];
    ours[event] = lst.filter((e: any) => typeof e?.command === "string" && isArmadaSpoolCommand(e.command));
  }
  return createHash("sha256").update(JSON.stringify(ours)).digest("hex");
}
