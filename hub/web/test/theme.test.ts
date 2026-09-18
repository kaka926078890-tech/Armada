import { describe, expect, test } from "bun:test";
import {
  THEME_KEY, FONT_SCALE_KEY,
  loadTheme, otherTheme, saveTheme,
  loadFontScale, saveFontScale, zoomForFontScale, applyFontScale,
} from "../src/theme";

const mem = new Map<string, string>();
(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: () => null,
  get length() { return mem.size; },
} as Storage;

describe("theme", () => {
  test("unknown or missing storage is dark", () => {
    localStorage.removeItem(THEME_KEY);
    expect(loadTheme()).toBe("dark");
    localStorage.setItem(THEME_KEY, "nope");
    expect(loadTheme()).toBe("dark");
  });

  test("light round-trips", () => {
    saveTheme("light");
    expect(loadTheme()).toBe("light");
    saveTheme("dark");
    expect(loadTheme()).toBe("dark");
  });

  test("otherTheme toggles", () => {
    expect(otherTheme("dark")).toBe("light");
    expect(otherTheme("light")).toBe("dark");
  });
});

describe("fontScale", () => {
  test("unknown or missing storage is normal", () => {
    localStorage.removeItem(FONT_SCALE_KEY);
    expect(loadFontScale()).toBe("normal");
    localStorage.setItem(FONT_SCALE_KEY, "1.5");
    expect(loadFontScale()).toBe("normal");
  });

  test("large and xlarge round-trip", () => {
    saveFontScale("large");
    expect(loadFontScale()).toBe("large");
    saveFontScale("xlarge");
    expect(loadFontScale()).toBe("xlarge");
  });

  test("zoom is 1 / 1.25 / 1.5", () => {
    expect(zoomForFontScale("normal")).toBe(1);
    expect(zoomForFontScale("large")).toBe(1.25);
    expect(zoomForFontScale("xlarge")).toBe(1.5);
  });

  test("applyFontScale writes data-font-scale", () => {
    const el = { dataset: {} as Record<string, string> };
    (globalThis as { document?: { documentElement: typeof el } }).document = { documentElement: el };
    applyFontScale("large");
    expect(el.dataset.fontScale).toBe("large");
  });
});
