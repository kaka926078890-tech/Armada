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
  test("offers theme, font scales, and prompt snippets", () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        theme="dark"
        fontScale="normal"
        onTheme={() => {}}
        onFontScale={() => {}}
        onClose={() => {}}
        snippets={[]}
        saveSnippets={async () => {}}
      />,
    );
    expect(html).toContain("设置");
    expect(html).toContain("黑夜");
    expect(html).toContain("明亮");
    expect(html).toContain("正常");
    expect(html).toContain("超大");
    expect(html).toContain("快捷提示词");
    expect(html).toContain("还没有快捷提示词，在输入框上方点添加");
    expect(html).not.toContain("解绑");
    expect(html).not.toContain("跟随系统");
    expect(html).toContain("消息免打扰");
    expect(html).toContain("清除所有已读");
    expect(html).toContain("未读红点改为灰点");
    expect(html).toContain('disabled=""');
  });

  test("quiet mode is pressed and clear-all is enabled when there is unread", () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        theme="dark"
        fontScale="normal"
        onTheme={() => {}}
        onFontScale={() => {}}
        onClose={() => {}}
        quietUnread
        canMarkAllRead
        onQuietUnread={() => {}}
        onMarkAllRead={() => {}}
      />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('disabled=""');
  });

  test("lists saved snippets as chips with a corner delete", () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        theme="dark"
        fontScale="normal"
        onTheme={() => {}}
        onFontScale={() => {}}
        onClose={() => {}}
        snippets={[{ id: "ok-id-01", title: "规范", body: "先写测试" }]}
        saveSnippets={async () => {}}
      />,
    );
    expect(html).toContain("快捷提示词");
    expect(html).toContain("规范");
    expect(html).toContain("rounded-full");
    expect(html).toContain('aria-label="删除 规范"');
    expect(html).toContain("×");
    expect(html).not.toContain("先写测试");
    expect(html).not.toContain("编辑快捷提示词");
    const src = readFileSync(join(root, "src/components/SettingsModal.tsx"), "utf8");
    expect(src).toContain('heading="编辑快捷提示词"');
    expect(src).toContain("AddSnippetDialog");
  });
});
