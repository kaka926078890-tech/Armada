import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const web = join(import.meta.dir, "..");
const repo = join(web, "../..");

describe("appearance layout stays coordinated when text scales", () => {
  test("root rem follows --armada-text-scale so padding/gap match type", () => {
    const css = readFileSync(join(web, "src/index.css"), "utf8");
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*calc\(16px \* var\(--armada-text-scale\)\)/);
    expect(css).toMatch(/html\s*\{[^}]*--armada-text-scale:\s*1/);
    expect(css).not.toMatch(/data-font-scale="large"[^{]*\{[^}]*zoom\s*:/);
  });

  test("header chips cannot squeeze CJK into a glyph column", () => {
    const app = readFileSync(join(web, "src/App.tsx"), "utf8");
    const header = app.slice(app.indexOf("<header"), app.indexOf("</header>"));
    expect(header).toContain("flex-wrap");
    expect(header).toContain("whitespace-nowrap");
    expect(header).toContain("shrink-0");
  });

  test("sidebar and board columns stay px so the canvas does not zoom", () => {
    const sidebar = readFileSync(join(web, "src/components/Sidebar.tsx"), "utf8");
    const board = readFileSync(join(web, "src/components/Board.tsx"), "utf8");
    expect(sidebar).toContain("w-[224px]");
    expect(board).toMatch(/w-\[240px\].*min-w-\[240px\].*max-w-\[240px\]/);
  });

  test("desktop window is a board, not an 800x600 document", () => {
    const conf = JSON.parse(readFileSync(join(repo, "desktop/src-tauri/tauri.conf.json"), "utf8"));
    const win = conf.app.windows[0];
    expect(win.width).toBeGreaterThanOrEqual(1280);
    expect(win.height).toBeGreaterThanOrEqual(800);
    expect(win.minWidth).toBeGreaterThanOrEqual(1024);
    expect(win.minHeight).toBeGreaterThanOrEqual(640);
  });
});
