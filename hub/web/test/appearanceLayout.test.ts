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

  test("run detail overlay covers the machine sidebar below the header", () => {
    const app = readFileSync(join(web, "src/App.tsx"), "utf8");
    const body = app.slice(app.indexOf("</header>"));
    expect(body).toMatch(/flex flex-1 min-h-0 relative[\s\S]*<Sidebar[\s\S]*absolute inset-0 z-40/);
    expect(body).not.toMatch(/<Sidebar[\s\S]*flex-col relative[\s\S]*absolute inset-0 z-40/);
    expect(app).not.toContain("fixed inset-0 z-40");
  });

  test("kanban titles wrap by word and clamp later lines", () => {
    const board = readFileSync(join(web, "src/components/Board.tsx"), "utf8");
    expect(board).not.toContain("break-all");
    expect(board).toContain("break-words");
    expect(board).toMatch(/line-clamp-2/);
    expect(board).toContain("clipCardTitle");
    expect(board).toContain("whitespace-nowrap");
  });

  test("sidebar and board columns keep a 240px floor; extra width can grow", () => {
    const sidebar = readFileSync(join(web, "src/components/Sidebar.tsx"), "utf8");
    const board = readFileSync(join(web, "src/components/Board.tsx"), "utf8");
    const button = readFileSync(join(web, "src/components/ui/button.tsx"), "utf8");
    expect(sidebar).toContain("w-[224px]");
    expect(button).toContain("whitespace-nowrap");
    expect(board).toContain("min-w-[240px]");
    expect(board).not.toMatch(/max-w-\[240px\]/);
  });

  test("hub and App share cursor vsix reload controls on the machine region", () => {
    const app = readFileSync(join(web, "src/App.tsx"), "utf8");
    const ios = readFileSync(join(repo, "mobile/ios/ArmadaRemote/Screens.swift"), "utf8");
    const android = readFileSync(join(repo, "mobile/android/app/src/main/java/app/armada/remote/MainActivity.kt"), "utf8");
    expect(app).not.toContain("CursorReloadBar");
    expect(app).toContain("reloadMachineIds");
    expect(ios).toContain("现在 Reload");
    expect(android).toContain("现在 Reload");
    expect(ios).toContain("machineId");
    expect(android).toContain("machineId");
    const sidebar = readFileSync(join(web, "src/components/Sidebar.tsx"), "utf8");
    expect(sidebar).toContain("onReloadMachine");
    expect(sidebar).toContain("现在 Reload");
    const board = readFileSync(join(web, "src/components/Board.tsx"), "utf8");
    expect(board).not.toContain("extensionLagNotice");
    expect(ios).not.toContain("本机 Cursor 扩展已更新");
    expect(android).not.toContain("本机 Cursor 扩展已更新");
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
