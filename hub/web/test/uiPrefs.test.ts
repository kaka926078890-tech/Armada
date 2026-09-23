import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  UI_PREFS_DEFAULTS,
  QUIET_UNREAD_KEY,
  applyUiPrefsToLocalStorage,
  loadQuietUnread,
  saveQuietUnread,
  shouldMigrateLocal,
  shouldSeedReadRuns,
  localDiffersFromDefaults,
} from "../src/uiPrefs";

const mem = new Map<string, string>();
(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: () => null,
  get length() { return mem.size; },
} as Storage;

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
    expect(localDiffersFromDefaults({ ...UI_PREFS_DEFAULTS, fontScale: "large" })).toBe(true);
    expect(localDiffersFromDefaults({ ...UI_PREFS_DEFAULTS, promptSnippets: [] })).toBe(false);
    expect(localDiffersFromDefaults({
      ...UI_PREFS_DEFAULTS,
      promptSnippets: [{ id: "ok-id-01", title: "t", body: "b" }],
    })).toBe(false);
  });
});

describe("quiet unread stays on this board", () => {
  test("hub prefs do not overwrite the local switch", () => {
    saveQuietUnread(true);
    applyUiPrefsToLocalStorage({ ...UI_PREFS_DEFAULTS, theme: "light" });
    expect(loadQuietUnread()).toBe(true);
    expect(localStorage.getItem(QUIET_UNREAD_KEY)).toBe("1");
    saveQuietUnread(false);
    applyUiPrefsToLocalStorage(UI_PREFS_DEFAULTS);
    expect(loadQuietUnread()).toBe(false);
  });

  test("App does not read or write quietUnread through ui-prefs", () => {
    const app = readFileSync(join(import.meta.dir, "../src/App.tsx"), "utf8");
    expect(app).not.toMatch(/putUiPrefs\(\{[^}]*quietUnread/);
    expect(app).not.toContain("prefs.quietUnread");
    expect(app).not.toContain("migrated.quietUnread");
    expect(app).toContain("saveQuietUnread(next)");
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
