import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  UI_PREFS_DEFAULTS, normalizeUiPrefs, normalizePromptSnippets, isWorkspaceKey,
  readUiPrefs, writeUiPrefs, mergeUiPrefs,
  assertPromptSnippets, fillSnippetIds, SNIPPET_ID_RE, SNIPPET_MAX,
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
      detailWidth: 0.4,
    });
    expect(normalizeUiPrefs({ detailWidth: 0.5 }).detailWidth).toBe(0.5);
    expect(normalizeUiPrefs({ detailWidth: 576 }).detailWidth).toBeCloseTo(576 / 1440);
  });

  test("clamps illegal fontScale to normal", () => {
    expect(normalizeUiPrefs({ fontScale: "neon" }).fontScale).toBe("normal");
    expect(normalizeUiPrefs({ fontScale: 1.5 }).fontScale).toBe("normal");
    expect(normalizeUiPrefs({}).fontScale).toBe("normal");
    expect(normalizeUiPrefs({ fontScale: "large" }).fontScale).toBe("large");
    expect(normalizeUiPrefs({ fontScale: "xlarge" }).fontScale).toBe("xlarge");
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

  test("quietUnread defaults off and only accepts true", () => {
    expect(normalizeUiPrefs({}).quietUnread).toBe(false);
    expect(normalizeUiPrefs({ quietUnread: true }).quietUnread).toBe(true);
    expect(normalizeUiPrefs({ quietUnread: "yes" }).quietUnread).toBe(false);
    const base = { ...UI_PREFS_DEFAULTS, quietUnread: true };
    expect(mergeUiPrefs(base, { theme: "light" }).quietUnread).toBe(true);
    expect(mergeUiPrefs(base, { quietUnread: false }).quietUnread).toBe(false);
  });

  test("merge PUT fontScale keeps theme", () => {
    const base = { ...UI_PREFS_DEFAULTS, theme: "light" as const };
    const next = mergeUiPrefs(base, { fontScale: "large" });
    expect(next.fontScale).toBe("large");
    expect(next.theme).toBe("light");
  });
});

describe("promptSnippets", () => {
  test("defaults include empty promptSnippets", () => {
    expect(UI_PREFS_DEFAULTS.promptSnippets).toEqual([]);
    expect(normalizeUiPrefs({}).promptSnippets).toEqual([]);
  });

  test("read path drops illegal snippets", () => {
    const n = normalizeUiPrefs({
      promptSnippets: [
        { id: "bad", title: "x", body: "y" },
        { id: "ok-id-01", title: "t", body: "b" },
        { id: "ok-id-02", title: "", body: "b" },
      ],
    });
    expect(n.promptSnippets).toEqual([{ id: "ok-id-01", title: "t", body: "b" }]);
  });

  test("normalize keeps first 30 legal snippets when 31 are stored", () => {
    const raw = Array.from({ length: 31 }, (_, i) => ({
      id: `id-${String(i).padStart(6, "0")}`,
      title: "t",
      body: "b",
    }));
    for (const s of raw) expect(s.id).toMatch(SNIPPET_ID_RE);

    const viaNormalize = normalizePromptSnippets(raw);
    expect(viaNormalize).toHaveLength(SNIPPET_MAX);
    expect(viaNormalize.map((s) => s.id)).toEqual(
      raw.slice(0, SNIPPET_MAX).map((s) => s.id),
    );
    expect(viaNormalize.some((s) => s.id === raw[30]!.id)).toBe(false);

    const viaUiPrefs = normalizeUiPrefs({ promptSnippets: raw }).promptSnippets;
    expect(viaUiPrefs).toEqual(viaNormalize);
  });

  test("merge promptSnippets keeps theme", () => {
    const base = { ...UI_PREFS_DEFAULTS, theme: "light" as const };
    const next = mergeUiPrefs(base, { promptSnippets: [{ id: "ok-id-01", title: "t", body: "b" }] });
    expect(next.theme).toBe("light");
    expect(next.promptSnippets).toHaveLength(1);
  });

  test("assert rejects over 30, empty title, duplicate ids, empty id", () => {
    expect(assertPromptSnippets("x").ok).toBe(false);
    if (!assertPromptSnippets("x").ok) expect(assertPromptSnippets("x").error).toBe("SNIPPET_INVALID");
    const tooMany = Array.from({ length: 31 }, (_, i) => ({
      id: `id-${String(i).padStart(6, "0")}`, title: "t", body: "b",
    }));
    const lim = assertPromptSnippets(tooMany);
    expect(lim.ok).toBe(false);
    if (!lim.ok) expect(lim.error).toBe("SNIPPET_LIMIT");
    expect(assertPromptSnippets([{ title: "  ", body: "b" }]).ok).toBe(false);
    expect(assertPromptSnippets([
      { id: "ok-id-01", title: "a", body: "b" },
      { id: "ok-id-01", title: "c", body: "d" },
    ]).ok).toBe(false);
    expect(assertPromptSnippets([{ id: "", title: "a", body: "b" }]).ok).toBe(false);
  });

  test("assert allows omitted id; fillSnippetIds assigns uuid", () => {
    const a = assertPromptSnippets([{ title: "a", body: "b" }]);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const filled = fillSnippetIds(a.snippets);
    expect(filled[0]!.id).toMatch(SNIPPET_ID_RE);
    expect(filled[0]!.title).toBe("a");
  });
});
