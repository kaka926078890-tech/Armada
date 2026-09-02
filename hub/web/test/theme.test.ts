import { describe, expect, test } from "bun:test";
import { THEME_KEY, loadTheme, otherTheme, saveTheme } from "../src/theme";

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
