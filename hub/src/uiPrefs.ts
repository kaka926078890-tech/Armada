import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "./writeFileAtomic";

export type ThemeName = "dark" | "light";
export type FontScale = "normal" | "large" | "xlarge";

export type PromptSnippet = { id: string; title: string; body: string };
export const SNIPPET_MAX = 30;
export const SNIPPET_TITLE_MAX = 40;
export const SNIPPET_BODY_MAX = 8000;
export const SNIPPET_ID_RE = /^[a-z0-9-]{8,64}$/;

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

function asSnippetItem(raw: unknown): { id?: string; title: string; body: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== "string" || typeof o.body !== "string") return null;
  const title = o.title.trim();
  const body = o.body.trim();
  if (title.length < 1 || title.length > SNIPPET_TITLE_MAX) return null;
  if (body.length < 1 || body.length > SNIPPET_BODY_MAX) return null;
  if (o.id === undefined || o.id === null) return { title, body };
  if (typeof o.id !== "string" || !SNIPPET_ID_RE.test(o.id)) return null;
  return { id: o.id, title, body };
}

export function normalizePromptSnippets(raw: unknown): PromptSnippet[] {
  if (!Array.isArray(raw)) return [];
  const out: PromptSnippet[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = asSnippetItem(item);
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, title: s.title, body: s.body });
    if (out.length >= SNIPPET_MAX) break;
  }
  return out;
}

export function assertPromptSnippets(raw: unknown):
  { ok: true; snippets: Array<{ id?: string; title: string; body: string }> } |
  { ok: false; error: "SNIPPET_INVALID" | "SNIPPET_LIMIT" } {
  if (!Array.isArray(raw)) return { ok: false, error: "SNIPPET_INVALID" };
  if (raw.length > SNIPPET_MAX) return { ok: false, error: "SNIPPET_LIMIT" };
  const snippets: Array<{ id?: string; title: string; body: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = asSnippetItem(item);
    if (!s) return { ok: false, error: "SNIPPET_INVALID" };
    if (s.id) {
      if (seen.has(s.id)) return { ok: false, error: "SNIPPET_INVALID" };
      seen.add(s.id);
    }
    snippets.push(s);
  }
  return { ok: true, snippets };
}

export function fillSnippetIds(items: Array<{ id?: string; title: string; body: string }>): PromptSnippet[] {
  return items.map((s) => ({
    id: s.id && SNIPPET_ID_RE.test(s.id) ? s.id : crypto.randomUUID(),
    title: s.title,
    body: s.body,
  }));
}

const READ_RUNS_CAP = 5000;
const DETAIL_RATIO_MIN = 0.22;
const DETAIL_RATIO_MAX = 0.92;
const DETAIL_RATIO_DEFAULT = 0.4;
const DETAIL_LEGACY_VW = 1440;

function normalizeDetailWidth(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DETAIL_RATIO_DEFAULT;
  if (raw <= 1.5) return Math.min(DETAIL_RATIO_MAX, Math.max(DETAIL_RATIO_MIN, raw));
  return Math.min(DETAIL_RATIO_MAX, Math.max(DETAIL_RATIO_MIN, raw / DETAIL_LEGACY_VW));
}

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
  const fontScale = o.fontScale === "large" || o.fontScale === "xlarge" || o.fontScale === "normal"
    ? o.fontScale
    : "normal";
  const selectedWorkspace = isWorkspaceKey(o.selectedWorkspace) ? o.selectedWorkspace : null;
  const detailWidth = normalizeDetailWidth(o.detailWidth);
  return {
    version: 1,
    theme,
    fontScale,
    selectedWorkspace,
    readRuns: clampReadRuns(o.readRuns),
    readRunsSeeded: o.readRunsSeeded === true,
    detailWidth,
    promptSnippets: normalizePromptSnippets(o.promptSnippets),
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
  writeFileAtomic(prefsPath(home), JSON.stringify(normalizeUiPrefs(prefs)), 0o600);
}

export function mergeUiPrefs(base: UiPrefs, patch: Record<string, unknown>): UiPrefs {
  const known = ["theme", "fontScale", "selectedWorkspace", "readRuns", "readRunsSeeded", "detailWidth", "promptSnippets"] as const;
  const next: Record<string, unknown> = { ...base };
  for (const k of known) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  }
  return normalizeUiPrefs(next);
}
