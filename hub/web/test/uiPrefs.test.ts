import { describe, expect, test } from "bun:test";
import {
  UI_PREFS_DEFAULTS,
  shouldMigrateLocal,
  shouldSeedReadRuns,
  localDiffersFromDefaults,
} from "../src/uiPrefs";

describe("shouldMigrateLocal", () => {
  test("migrate only when source defaults AND local differs", () => {
    expect(shouldMigrateLocal("defaults", { ...UI_PREFS_DEFAULTS, theme: "light" })).toBe(true);
    expect(shouldMigrateLocal("defaults", { ...UI_PREFS_DEFAULTS })).toBe(false);
    expect(shouldMigrateLocal("file", { ...UI_PREFS_DEFAULTS, theme: "light" })).toBe(false);
  });

  test("localDiffersFromDefaults catches readRuns / width / seeded", () => {
    expect(localDiffersFromDefaults(UI_PREFS_DEFAULTS)).toBe(false);
    expect(localDiffersFromDefaults({ ...UI_PREFS_DEFAULTS, readRuns: { r1: 1 } })).toBe(true);
    expect(localDiffersFromDefaults({ ...UI_PREFS_DEFAULTS, detailWidth: 800 })).toBe(true);
    expect(localDiffersFromDefaults({ ...UI_PREFS_DEFAULTS, readRunsSeeded: true })).toBe(true);
  });
});

describe("shouldSeedReadRuns", () => {
  test("seed only when prefsReady and not seeded and runs>0", () => {
    expect(shouldSeedReadRuns({ prefsReady: false, readRunsSeeded: false, runsLength: 3 })).toBe(false);
    expect(shouldSeedReadRuns({ prefsReady: true, readRunsSeeded: false, runsLength: 3 })).toBe(true);
    expect(shouldSeedReadRuns({ prefsReady: true, readRunsSeeded: true, runsLength: 3 })).toBe(false);
    expect(shouldSeedReadRuns({ prefsReady: true, readRunsSeeded: false, runsLength: 0 })).toBe(false);
  });
});
