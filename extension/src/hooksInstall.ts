import { createHash } from "crypto";

export const HOOK_EVENTS = [
  "sessionStart", "sessionEnd", "beforeSubmitPrompt", "preToolUse", "postToolUse",
  "postToolUseFailure", "beforeShellExecution", "afterShellExecution", "afterFileEdit",
  "afterAgentResponse", "afterAgentThought", "subagentStart", "subagentStop",
  "preCompact", "stop",
] as const;

export function spoolScriptName(platform: string = process.platform): string {
  return platform === "win32" ? "armada-spool.ps1" : "armada-spool.sh";
}

export function isArmadaSpoolCommand(command: string): boolean {
  return command.includes("armada-spool.sh") || command.includes("armada-spool.ps1");
}

export function hookCommand(scriptPath: string, event: string): string {
  if (scriptPath.toLowerCase().endsWith(".ps1")) {
    // Cursor's Windows hook runner is bash: backslashes in -File "C:\Users\..." get eaten.
    const posix = scriptPath.replace(/\\/g, "/");
    return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${posix}" ${event}`;
  }
  return `${scriptPath} ${event}`;
}

export function mergeHooks(existing: any, scriptPath: string): { merged: any; changed: boolean } {
  const merged = existing && typeof existing === "object" ? JSON.parse(JSON.stringify(existing)) : { version: 1 };
  if (!merged.hooks || typeof merged.hooks !== "object") merged.hooks = {};
  let changed = false;
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(merged.hooks[event])) merged.hooks[event] = [];
    const lst = merged.hooks[event] as any[];
    const expected = { command: hookCommand(scriptPath, event), timeout: 5 };
    const rest = lst.filter((e) => !(typeof e?.command === "string" && isArmadaSpoolCommand(e.command)));
    const ours = lst.filter((e) => typeof e?.command === "string" && isArmadaSpoolCommand(e.command));
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
