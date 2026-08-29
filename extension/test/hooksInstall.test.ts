import { describe, expect, test } from "bun:test";
import { mergeHooks, hooksDriftHash, HOOK_EVENTS } from "../src/hooksInstall";

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

  test("drift vs expected: tampered timeout still containing armada-spool.sh is detected", () => {
    const scriptPath = "/s/armada-spool.sh";
    const { merged: expected } = mergeHooks(null, scriptPath);
    const existing = JSON.parse(JSON.stringify(expected));
    // Tamper timeout but keep armada-spool.sh substring — mergeHooks skips (changed=false).
    existing.hooks.stop[0].timeout = 99;
    expect(mergeHooks(existing, scriptPath).changed).toBe(false);
    // Comparing to expected canonical merge detects drift (old bug: compare to merge(existing) → always equal).
    expect(hooksDriftHash(existing) !== hooksDriftHash(mergeHooks(null, scriptPath).merged)).toBe(true);
  });
});
