import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const web = join(import.meta.dir, "..");
const repo = join(web, "../..");

describe("appearance layout stays coordinated when text scales", () => {
  test("root rem stays 16px so scaled type does not explode padding in pinned shells", () => {
    const css = readFileSync(join(web, "src/index.css"), "utf8");
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*16px/);
    expect(css).not.toMatch(/html\s*\{[^}]*font-size:\s*calc\(16px \* var\(--armada-text-scale\)\)/);
    expect(css).toMatch(/html\[data-font-scale="large"\][^{]*\{[^}]*--armada-text-scale:\s*1\.25/);
    expect(css).toMatch(/html\[data-font-scale="xlarge"\][^{]*\{[^}]*--armada-text-scale:\s*1\.5/);
    expect(css).not.toMatch(/data-font-scale="large"[^{]*\{[^}]*zoom\s*:/);
  });

  test("header chips cannot squeeze CJK into a glyph column", () => {
    const app = readFileSync(join(web, "src/App.tsx"), "utf8");
    const header = app.slice(app.indexOf("<header"), app.indexOf("</header>"));
    expect(header).toContain("flex-wrap");
    expect(header).toContain("whitespace-nowrap");
    expect(header).toContain("shrink-0");
  });

  test("kanban titles wrap by word and clamp instead of glyph columns", () => {
    const board = readFileSync(join(web, "src/components/Board.tsx"), "utf8");
    expect(board).not.toContain("break-all");
    expect(board).toContain("break-words");
    expect(board).toContain("line-clamp-3");
    expect(board).toContain("whitespace-nowrap");
  });

  test("sidebar and board columns keep a 240px floor; extra width can grow", () => {
    const sidebar = readFileSync(join(web, "src/components/Sidebar.tsx"), "utf8");
    const board = readFileSync(join(web, "src/components/Board.tsx"), "utf8");
    const ui = readFileSync(join(web, "src/ui.ts"), "utf8");
    expect(sidebar).toContain("w-[224px]");
    expect(ui).toContain("whitespace-nowrap");
    expect(board).toContain("min-w-[240px]");
    expect(board).not.toMatch(/max-w-\[240px\]/);
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
