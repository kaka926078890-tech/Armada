import { describe, expect, test } from "bun:test";
import { mergeHooks, hooksDriftHash, HOOK_EVENTS, spoolScriptName } from "../src/hooksInstall";

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

  test("windows ps1 uses forward slashes so bash hook launcher does not eat the path", () => {
    const scriptPath = "C:\\Users\\a\\.cursor\\hooks\\armada-spool.ps1";
    const { merged, changed } = mergeHooks(null, scriptPath);
    expect(changed).toBe(true);
    expect(merged.hooks.stop[0].command).toBe(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:/Users/a/.cursor/hooks/armada-spool.ps1" stop`,
    );
    expect(mergeHooks(merged, scriptPath).changed).toBe(false);
  });

  test("repairs legacy backslash -File commands already in hooks.json", () => {
    const scriptPath = "C:\\Users\\PC\\.cursor\\hooks\\armada-spool.ps1";
    const legacy = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" stop`;
    const existing = {
      version: 1,
      hooks: { stop: [{ command: legacy, timeout: 5 }] },
    };
    const { merged, changed } = mergeHooks(existing, scriptPath);
    expect(changed).toBe(true);
    expect(merged.hooks.stop).toHaveLength(1);
    expect(merged.hooks.stop[0].command).toContain("-File \"C:/Users/PC/.cursor/hooks/armada-spool.ps1\" stop");
    expect(merged.hooks.stop[0].command).not.toContain("C:\\Users");
  });

  test("windows path with spaces stays quoted after slash normalize", () => {
    const scriptPath = "C:\\Users\\Foo Bar\\.cursor\\hooks\\armada-spool.ps1";
    const { merged } = mergeHooks(null, scriptPath);
    expect(merged.hooks.sessionStart[0].command).toContain(
      `-File "C:/Users/Foo Bar/.cursor/hooks/armada-spool.ps1" sessionStart`,
    );
  });

  test("spoolScriptName follows platform", () => {
    expect(spoolScriptName("win32")).toBe("armada-spool.ps1");
    expect(spoolScriptName("darwin")).toBe("armada-spool.sh");
    expect(spoolScriptName("linux")).toBe("armada-spool.sh");
  });
});
