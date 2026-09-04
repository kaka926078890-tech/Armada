import { applyTheme, loadTheme, saveTheme, type ThemeName } from "./theme";

export type UiPrefs = {
  version: 1;
  theme: ThemeName;
  selectedWorkspace: string | null;
  readRuns: Record<string, number>;
  readRunsSeeded: boolean;
  detailWidth: number;
};

export type UiPrefsGetResponse = UiPrefs & { source: "file" | "defaults" };

export const UI_PREFS_DEFAULTS: UiPrefs = {
  version: 1,
  theme: "dark",
  selectedWorkspace: null,
  readRuns: {},
  readRunsSeeded: false,
  detailWidth: 576,
};

export const WS_KEY = "armada.selectedWorkspace.v1";
export const READ_KEY = "armada.readRuns.v1";
export const READ_SEEDED = "armada.readRuns.seeded.v1";
export const WIDTH_KEY = "armada.detailWidth.v1";

export function loadLocalUiPrefsMirror(): UiPrefs {
  let selectedWorkspace: string | null = null;
  try { selectedWorkspace = localStorage.getItem(WS_KEY); } catch { /* ignore */ }
  let readRuns: Record<string, number> = {};
  try { readRuns = JSON.parse(localStorage.getItem(READ_KEY) || "{}"); } catch { readRuns = {}; }
  if (!readRuns || typeof readRuns !== "object" || Array.isArray(readRuns)) readRuns = {};
  let readRunsSeeded = false;
  try { readRunsSeeded = localStorage.getItem(READ_SEEDED) === "1"; } catch { /* ignore */ }
  let detailWidth = UI_PREFS_DEFAULTS.detailWidth;
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n >= 400) detailWidth = Math.min(2000, Math.round(n));
  } catch { /* ignore */ }
  return {
    version: 1,
    theme: loadTheme(),
    selectedWorkspace,
    readRuns,
    readRunsSeeded,
    detailWidth,
  };
}

export function applyUiPrefsToLocalStorage(p: UiPrefs): void {
  saveTheme(p.theme);
  applyTheme(p.theme);
  try {
    if (p.selectedWorkspace) localStorage.setItem(WS_KEY, p.selectedWorkspace);
    else localStorage.removeItem(WS_KEY);
  } catch { /* ignore */ }
  try { localStorage.setItem(READ_KEY, JSON.stringify(p.readRuns)); } catch { /* ignore */ }
  try {
    if (p.readRunsSeeded) localStorage.setItem(READ_SEEDED, "1");
    else localStorage.removeItem(READ_SEEDED);
  } catch { /* ignore */ }
  try { localStorage.setItem(WIDTH_KEY, String(p.detailWidth)); } catch { /* ignore */ }
}

export function localDiffersFromDefaults(local: UiPrefs): boolean {
  if (local.theme !== UI_PREFS_DEFAULTS.theme) return true;
  if (local.selectedWorkspace !== UI_PREFS_DEFAULTS.selectedWorkspace) return true;
  if (local.readRunsSeeded !== UI_PREFS_DEFAULTS.readRunsSeeded) return true;
  if (local.detailWidth !== UI_PREFS_DEFAULTS.detailWidth) return true;
  if (Object.keys(local.readRuns).length > 0) return true;
  return false;
}

/** Migrate LS → hub only when file was missing (source defaults) and LS has non-default data. */
export function shouldMigrateLocal(source: "file" | "defaults", local: UiPrefs): boolean {
  return source === "defaults" && localDiffersFromDefaults(local);
}

export function shouldSeedReadRuns(opts: {
  prefsReady: boolean;
  readRunsSeeded: boolean;
  runsLength: number;
}): boolean {
  return opts.prefsReady && !opts.readRunsSeeded && opts.runsLength > 0;
}
