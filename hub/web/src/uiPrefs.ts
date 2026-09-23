import { applyFontScale, applyTheme, loadFontScale, loadTheme, saveFontScale, saveTheme, type FontScale, type ThemeName } from "./theme";
import { DEFAULT_RATIO, parseStoredWidth } from "./detailWidth";

export type PromptSnippet = { id: string; title: string; body: string };

export type UiPrefs = {
  version: 1;
  theme: ThemeName;
  fontScale: FontScale;
  selectedWorkspace: string | null;
  readRuns: Record<string, number>;
  readRunsSeeded: boolean;
  detailWidth: number;
  promptSnippets: PromptSnippet[];
};

export type UiPrefsGetResponse = UiPrefs & { source: "file" | "defaults" };

export const UI_PREFS_DEFAULTS: UiPrefs = {
  version: 1,
  theme: "dark",
  fontScale: "normal",
  selectedWorkspace: null,
  readRuns: {},
  readRunsSeeded: false,
  detailWidth: 0.4,
  promptSnippets: [],
};

export const WS_KEY = "armada.selectedWorkspace.v1";
export const READ_KEY = "armada.readRuns.v1";
export const READ_SEEDED = "armada.readRuns.seeded.v1";
export const WIDTH_KEY = "armada.detailWidth.v1";
/** 消息免打扰只留在这块看板的 localStorage，不进 hub ui-prefs。 */
export const QUIET_UNREAD_KEY = "armada.quietUnread.v1";

export function loadQuietUnread(): boolean {
  try { return localStorage.getItem(QUIET_UNREAD_KEY) === "1"; } catch { return false; }
}

export function saveQuietUnread(on: boolean): void {
  try {
    if (on) localStorage.setItem(QUIET_UNREAD_KEY, "1");
    else localStorage.removeItem(QUIET_UNREAD_KEY);
  } catch { /* ignore */ }
}

export function loadLocalUiPrefsMirror(): UiPrefs {
  let selectedWorkspace: string | null = null;
  try { selectedWorkspace = localStorage.getItem(WS_KEY); } catch { /* ignore */ }
  let readRuns: Record<string, number> = {};
  try { readRuns = JSON.parse(localStorage.getItem(READ_KEY) || "{}"); } catch { readRuns = {}; }
  if (!readRuns || typeof readRuns !== "object" || Array.isArray(readRuns)) readRuns = {};
  let readRunsSeeded = false;
  try { readRunsSeeded = localStorage.getItem(READ_SEEDED) === "1"; } catch { /* ignore */ }
  let detailWidth = DEFAULT_RATIO;
  try {
    detailWidth = parseStoredWidth(localStorage.getItem(WIDTH_KEY), 1440).ratio;
  } catch { /* ignore */ }
  return {
    version: 1,
    theme: loadTheme(),
    fontScale: loadFontScale(),
    selectedWorkspace,
    readRuns,
    readRunsSeeded,
    detailWidth,
    promptSnippets: [],
  };
}

export function applyUiPrefsToLocalStorage(p: UiPrefs): void {
  saveTheme(p.theme);
  applyTheme(p.theme);
  const scale = p.fontScale === "large" || p.fontScale === "xlarge" ? p.fontScale : "normal";
  saveFontScale(scale);
  applyFontScale(scale);
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
  if (local.fontScale !== UI_PREFS_DEFAULTS.fontScale) return true;
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
