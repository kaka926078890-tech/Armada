import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const EXT = join(import.meta.dir, "..");

describe("vsix bundle", () => {
  test("keeps the node: prefix on node:sqlite so off-screen asks can read state.vscdb", () => {
    const out = mkdtempSync(join(tmpdir(), "armada-bundle-"));
    try {
      const r = spawnSync("npx", ["tsup", "--silent", "--no-sourcemap", "--out-dir", out], { cwd: EXT, encoding: "utf8" });
      expect(r.status).toBe(0);
      const js = readFileSync(join(out, "extension.js"), "utf8");
      expect(js).toContain('import("node:sqlite")');
      expect(js).not.toContain('import("sqlite")');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
