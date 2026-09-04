import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type ThemeName = "dark" | "light";

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

const READ_RUNS_CAP = 5000;
const WIDTH_MIN = 400;
const WIDTH_MAX = 2000;

export function isWorkspaceKey(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string";
  } catch {
    return false;
  }
}

function clampReadRuns(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries: [string, number][] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) entries.push([k, v]);
  }
  entries.sort((a, b) => a[1] - b[1]);
  const trimmed = entries.length > READ_RUNS_CAP ? entries.slice(entries.length - READ_RUNS_CAP) : entries;
  return Object.fromEntries(trimmed);
}

export function normalizeUiPrefs(raw: unknown): UiPrefs {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const theme = o.theme === "light" || o.theme === "dark" ? o.theme : "dark";
  const selectedWorkspace = isWorkspaceKey(o.selectedWorkspace) ? o.selectedWorkspace : null;
  const detailWidth = typeof o.detailWidth === "number" && Number.isFinite(o.detailWidth)
    ? Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(o.detailWidth)))
    : 576;
  return {
    version: 1,
    theme,
    selectedWorkspace,
    readRuns: clampReadRuns(o.readRuns),
    readRunsSeeded: o.readRunsSeeded === true,
    detailWidth,
  };
}

export function prefsPath(home: string): string {
  return join(home, "ui-prefs.json");
}

export type ReadUiPrefsResult =
  | { ok: true; prefs: UiPrefs; source: "file" | "defaults" }
  | { ok: false; error: "READ_FAIL" };

export function readUiPrefs(home: string): ReadUiPrefsResult {
  const p = prefsPath(home);
  if (!existsSync(p)) return { ok: true, prefs: { ...UI_PREFS_DEFAULTS }, source: "defaults" };
  try {
    const text = readFileSync(p, "utf8");
    const parsed = JSON.parse(text);
    return { ok: true, prefs: normalizeUiPrefs(parsed), source: "file" };
  } catch {
    return { ok: false, error: "READ_FAIL" };
  }
}

export function writeUiPrefs(home: string, prefs: UiPrefs): void {
  writeFileSync(prefsPath(home), JSON.stringify(normalizeUiPrefs(prefs)), { mode: 0o600 });
}

export function mergeUiPrefs(base: UiPrefs, patch: Record<string, unknown>): UiPrefs {
  const known = ["theme", "selectedWorkspace", "readRuns", "readRunsSeeded", "detailWidth"] as const;
  const next: Record<string, unknown> = { ...base };
  for (const k of known) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  }
  return normalizeUiPrefs(next);
}
