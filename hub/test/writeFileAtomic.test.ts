import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileAtomic } from "../src/writeFileAtomic";

describe("writeFileAtomic", () => {
  test("replaces the destination and leaves no tmp, mode 600", () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-atomic-"));
    const path = join(dir, "cfg.json");
    writeFileSync(path, "old");
    writeFileAtomic(path, '{"ok":true}', 0o600);
    expect(readFileSync(path, "utf8")).toBe('{"ok":true}');
    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("creates parent dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-atomic-"));
    const path = join(dir, "nested", "token");
    writeFileAtomic(path, "abc");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("abc");
  });

  test("Hub-m5 config writers import writeFileAtomic, not writeFileSync", async () => {
    const files = [
      new URL("../src/auth.ts", import.meta.url),
      new URL("../src/uiPrefs.ts", import.meta.url),
      new URL("../src/cursorReloadStore.ts", import.meta.url),
      new URL("../src/pairRedeem.ts", import.meta.url),
    ];
    for (const u of files) {
      const src = await Bun.file(u).text();
      expect(src).toMatch(/writeFileAtomic/);
      expect(src).not.toMatch(/writeFileSync/);
    }
  });
});
