import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsModal from "../src/components/SettingsModal";

const root = join(import.meta.dir, "..");

describe("settings chrome", () => {
  test("header opens a settings control instead of an inline theme toggle", () => {
    const app = readFileSync(join(root, "src/App.tsx"), "utf8");
    expect(app).toContain("设置");
    expect(app).not.toContain('aria-label="切换明亮/黑夜"');
  });

  test("css scales fonts only, not page zoom", () => {
    const css = readFileSync(join(root, "src/index.css"), "utf8");
    expect(css).not.toMatch(/data-font-scale="large"[^{]*\{[^}]*zoom\s*:/);
    expect(css).not.toMatch(/data-font-scale="xlarge"[^{]*\{[^}]*zoom\s*:/);
    expect(css).toMatch(/--armada-text-scale:\s*1\.25/);
    expect(css).toMatch(/--armada-text-scale:\s*1\.5/);
    expect(css).toMatch(/text-\\\[13px\\\][\s\S]{0,200}calc\(13px \* var\(--armada-text-scale/);
  });
});

describe("SettingsModal", () => {
  test("offers theme and three font scales only", () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        theme="dark"
        fontScale="normal"
        onTheme={() => {}}
        onFontScale={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("设置");
    expect(html).toContain("黑夜");
    expect(html).toContain("明亮");
    expect(html).toContain("正常");
    expect(html).toContain("超大");
    expect(html).not.toContain("解绑");
    expect(html).not.toContain("跟随系统");
  });
});
