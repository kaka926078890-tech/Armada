import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  UI_PREFS_DEFAULTS, normalizeUiPrefs, isWorkspaceKey,
  readUiPrefs, writeUiPrefs, mergeUiPrefs,
} from "../src/uiPrefs";

function tmpHome() { return mkdtempSync(join(tmpdir(), "armada-prefs-")); }

describe("isWorkspaceKey / normalizeUiPrefs", () => {
  test("accepts encodeWorkspaceKey shape", () => {
    expect(isWorkspaceKey(JSON.stringify(["m1", "/tmp/a"]))).toBe(true);
    expect(isWorkspaceKey("not-json")).toBe(false);
    expect(isWorkspaceKey('["m1"]')).toBe(false);
  });

  test("clamps illegal theme / width / workspace / readRuns", () => {
    const n = normalizeUiPrefs({
      version: 99,
      theme: "neon",
      selectedWorkspace: "bad",
      readRuns: { a: 1, b: "x", c: NaN },
      readRunsSeeded: "yes",
      detailWidth: -10,
      junk: true,
    });
    expect(n).toEqual({
      ...UI_PREFS_DEFAULTS,
      readRuns: { a: 1 },
      detailWidth: 400,
    });
  });

  test("caps readRuns at 5000 keeping newest by value", () => {
    const readRuns: Record<string, number> = {};
    for (let i = 0; i < 5002; i++) readRuns[`r-${i}`] = i;
    const n = normalizeUiPrefs({ ...UI_PREFS_DEFAULTS, readRuns });
    expect(Object.keys(n.readRuns)).toHaveLength(5000);
    expect(n.readRuns["r-0"]).toBeUndefined();
    expect(n.readRuns["r-5001"]).toBe(5001);
  });
});

describe("readUiPrefs / writeUiPrefs / merge", () => {
  test("missing file → defaults + source defaults", () => {
    const r = readUiPrefs(tmpHome());
    expect(r).toEqual({ ok: true, prefs: UI_PREFS_DEFAULTS, source: "defaults" });
  });

  test("round-trip write then read source file", () => {
    const home = tmpHome();
    writeUiPrefs(home, { ...UI_PREFS_DEFAULTS, theme: "light" });
    const r = readUiPrefs(home);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("file");
    expect(r.prefs.theme).toBe("light");
  });

  test("corrupt JSON → READ_FAIL", () => {
    const home = tmpHome();
    writeFileSync(join(home, "ui-prefs.json"), "{not-json", { mode: 0o600 });
    expect(readUiPrefs(home)).toEqual({ ok: false, error: "READ_FAIL" });
  });

  test("merge PUT theme keeps readRuns", () => {
    const base = { ...UI_PREFS_DEFAULTS, readRuns: { r1: 9 }, theme: "dark" as const };
    expect(mergeUiPrefs(base, { theme: "light" }).theme).toBe("light");
    expect(mergeUiPrefs(base, { theme: "light" }).readRuns).toEqual({ r1: 9 });
  });
});
