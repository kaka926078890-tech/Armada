import { describe, expect, test } from "bun:test";
import { mergeHooks, hooksDriftHash, HOOK_EVENTS, spoolScriptName, hookCommand, shouldInstallArmadaHooks } from "../src/hooksInstall";

describe("mergeHooks", () => {
  test("creates hooks object from scratch with all 15 events", () => {
    const { merged, changed } = mergeHooks(null, "/home/u/.cursor/hooks/armada-spool.sh");
    expect(changed).toBe(true);
    expect(Object.keys(merged.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(merged.hooks.stop[0].command).toBe("/home/u/.cursor/hooks/armada-spool.sh stop");
    expect(merged.hooks.stop[0].timeout).toBe(5);
  });

  test("preserves existing third-party entries", () => {
    const existing = { version: 1, hooks: { stop: [{ command: "/other/tool.sh stop", timeout: 10 }] } };
    const { merged } = mergeHooks(existing, "/s/armada-spool.sh");
    expect(merged.hooks.stop).toHaveLength(2);
    expect(merged.hooks.stop[0].command).toBe("/other/tool.sh stop");
  });

  test("idempotent: second merge changes nothing", () => {
    const first = mergeHooks(null, "/s/armada-spool.sh");
    const second = mergeHooks(first.merged, "/s/armada-spool.sh");
    expect(second.changed).toBe(false);
    expect(second.merged.hooks.stop).toHaveLength(1);
  });

  test("drift hash stable for same entries, changes on tamper", () => {
    const { merged } = mergeHooks(null, "/s/armada-spool.sh");
    const h1 = hooksDriftHash(merged);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hooksDriftHash(merged)).toBe(h1);
    const tampered = JSON.parse(JSON.stringify(merged));
    tampered.hooks.stop[0].command = "/evil.sh stop";
    expect(hooksDriftHash(tampered)).not.toBe(h1);
  });

  test("repairs our entry when timeout or command drifted", () => {
    const scriptPath = "/s/armada-spool.sh";
    const existing = mergeHooks(null, scriptPath).merged;
    existing.hooks.stop[0].timeout = 99;
    const { merged, changed } = mergeHooks(existing, scriptPath);
    expect(changed).toBe(true);
    expect(merged.hooks.stop[0].timeout).toBe(5);
    expect(merged.hooks.stop[0].command).toBe("/s/armada-spool.sh stop");
  });

  test("windows exe command is a quoted Windows path (kept for hookCommand, not installed)", () => {
    const cmd = hookCommand("C:\\Users\\a\\.cursor\\hooks\\armada-spool.exe", "stop");
    expect(cmd).toBe(`"C:\\Users\\a\\.cursor\\hooks\\armada-spool.exe" stop`);
    expect(cmd).not.toContain("powershell.exe");
    expect(cmd).not.toMatch(/^sh /);
    expect(cmd).not.toContain("/c/");
  });

  test("repairs leftover Windows spool commands by deleting them", () => {
    const scriptPath = "C:\\Users\\PC\\.cursor\\hooks\\armada-spool.exe";
    const legacy = `"C:\\Users\\PC\\.cursor\\hooks\\armada-spool.ps1" stop`;
    const existing = {
      version: 1,
      hooks: { stop: [{ command: legacy, timeout: 5 }] },
    };
    const { merged, changed } = mergeHooks(existing, scriptPath);
    expect(changed).toBe(true);
    expect(merged.hooks.stop).toEqual([]);
  });

  test("windows exe path with spaces stays quoted", () => {
    expect(hookCommand("C:\\Users\\Foo Bar\\.cursor\\hooks\\armada-spool.exe", "sessionStart")).toBe(
      `"C:\\Users\\Foo Bar\\.cursor\\hooks\\armada-spool.exe" sessionStart`,
    );
  });

  test("spoolScriptName is exe on Windows and sh elsewhere", () => {
    expect(spoolScriptName("win32")).toBe("armada-spool.exe");
    expect(spoolScriptName("darwin")).toBe("armada-spool.sh");
    expect(spoolScriptName("linux")).toBe("armada-spool.sh");
  });

  test("windows exe installs no Armada hook events (PowerShell wrapper cannot beat 5s)", () => {
    const scriptPath = "C:\\Users\\a\\.cursor\\hooks\\armada-spool.exe";
    const { merged, changed } = mergeHooks(null, scriptPath);
    expect(changed).toBe(false);
    for (const event of HOOK_EVENTS) {
      const ours = (merged.hooks[event] ?? []).filter((e: { command?: string }) =>
        typeof e.command === "string" && e.command.includes("armada-spool"),
      );
      expect(ours).toHaveLength(0);
    }
  });

  test("does not install the Cursor Get-Content|$input wrap as a bind path", () => {
    // Cursor Windows: Get-Content -Raw | & { $input | & "armada-spool.exe" event } with stdin=ignore, timeout 5s.
    // Direct-spawn exe tests stay green; this lock is what prevents shipping that as the bind path again.
    expect(shouldInstallArmadaHooks("C:\\Users\\PC\\.cursor\\hooks\\armada-spool.exe")).toBe(false);
    expect(shouldInstallArmadaHooks("/home/u/.cursor/hooks/armada-spool.sh")).toBe(true);
  });

  test("windows merge strips leftover 15 exe/ps1/sh entries and keeps third-party", () => {
    const scriptPath = "C:\\Users\\PC\\.cursor\\hooks\\armada-spool.exe";
    const existing = mergeHooks(null, "/s/armada-spool.sh").merged;
    existing.hooks.stop.push({ command: "/other/tool.sh stop", timeout: 10 });
    const { merged, changed } = mergeHooks(existing, scriptPath);
    expect(changed).toBe(true);
    expect(merged.hooks.stop).toEqual([{ command: "/other/tool.sh stop", timeout: 10 }]);
    expect(merged.hooks.beforeSubmitPrompt.some((e: { command?: string }) =>
      typeof e.command === "string" && e.command.includes("armada-spool"),
    )).toBe(false);
  });
});
