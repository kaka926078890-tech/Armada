import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { AddSnippetDialog, PromptSnippetBar } from "../src/components/PromptSnippetBar";
import type { PromptSnippet } from "../src/uiPrefs";

const root = join(import.meta.dir, "..");
const mobile = join(root, "..", "..", "mobile");
const sample: PromptSnippet = { id: "ok-id-01", title: "规范", body: "先写测试" };

describe("PromptSnippetBar", () => {
  test("renders titled chips and an add control without delete X", () => {
    const html = renderToStaticMarkup(
      <PromptSnippetBar snippets={[sample]} onAppend={() => {}} onAdd={async () => {}} />,
    );
    expect(html).toContain("规范");
    expect(html).toContain('aria-label="添加快捷提示词"');
    expect(html).toContain("添加");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("删除");
    expect(html).not.toContain("✕");
    expect(html).not.toContain("×");
  });

  test("add dialog is a dedicated overlay, not an inline nested form", () => {
    const html = renderToStaticMarkup(
      <AddSnippetDialog
        title=""
        body=""
        error=""
        saving={false}
        onTitle={() => {}}
        onBody={() => {}}
        onCancel={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("添加快捷提示词");
    expect(html).toContain("例如：代码审查");
    expect(html).toContain("点标题后追加到输入框末尾");
    expect(html).toContain("取消");
    expect(html).toContain("保存");
    expect(html).toContain("fixed inset-0");
  });

  test("disables add at 30 snippets", () => {
    const snippets = Array.from({ length: 30 }, (_, i) => ({
      id: `ok-id-${String(i).padStart(2, "0")}`,
      title: `t${i}`,
      body: "b",
    }));
    const html = renderToStaticMarkup(
      <PromptSnippetBar snippets={snippets} onAppend={() => {}} onAdd={async () => {}} />,
    );
    expect(html).toContain("最多 30 条");
    expect(html).toContain("disabled");
  });
});

describe("prompt snippet wiring", () => {
  test("dispatch and followup append via appendSnippetBody above the textarea", () => {
    const dispatch = readFileSync(join(root, "src/components/Modals.tsx"), "utf8");
    const detail = readFileSync(join(root, "src/components/RunDetail.tsx"), "utf8");
    expect(dispatch).toContain("PromptSnippetBar");
    expect(dispatch).toContain("appendSnippetBody");
    expect(dispatch.indexOf("<PromptSnippetBar")).toBeLessThan(dispatch.indexOf("<textarea"));
    expect(detail).toContain("PromptSnippetBar");
    expect(detail).toContain("appendSnippetBody");
    expect(detail.indexOf("<PromptSnippetBar")).toBeLessThan(detail.indexOf("value={followup}"));
  });

  test("App loads snippets when authed, rolls back PUT, and never writes ui-prefs snippets", () => {
    const app = readFileSync(join(root, "src/App.tsx"), "utf8");
    const api = readFileSync(join(root, "src/api.ts"), "utf8");
    expect(api).toContain("getPromptSnippets");
    expect(api).toContain("putPromptSnippets");
    expect(api).toContain("/api/prompt-snippets");
    expect(app).toContain("getPromptSnippets");
    expect(app).toContain("putPromptSnippets");
    expect(app).toContain("if (authed) reloadSnippets()");
    expect(app).toContain("setSnippets(prev)");
    expect(app).not.toContain("putUiPrefs({ promptSnippets");
    expect(app).not.toMatch(/putUiPrefs\(\{[^}]*promptSnippets/);
  });

  test("app dispatch syncs snippets and does not create", () => {
    const ios = readFileSync(join(mobile, "ios/ArmadaRemote/Screens.swift"), "utf8");
    const android = readFileSync(join(mobile, "android/app/src/main/java/app/armada/remote/MainActivity.kt"), "utf8");
    const iosDispatch = ios.slice(ios.indexOf("struct DispatchSheet"), ios.indexOf("struct DetailPromptCard"));
    expect(iosDispatch).toContain("loadSnippets");
    expect(iosDispatch).toContain("appendSnippetBody");
    expect(iosDispatch).not.toContain("addingSnippet");
    expect(iosDispatch).not.toContain("saveSnippets");
    expect(iosDispatch).not.toContain("UUID().uuidString");
    const androidDispatch = android.slice(android.indexOf("fun DispatchSheet"), android.indexOf("fun RunDetailScreen"));
    expect(androidDispatch).toContain("loadSnippets");
    expect(androidDispatch).toContain("appendSnippetBody");
    expect(androidDispatch).not.toContain("addingSnippet");
    expect(androidDispatch).not.toContain("saveSnippets");
    expect(androidDispatch).not.toContain("UUID.randomUUID");
    expect(ios).toContain("还没有快捷提示词，请在中台添加");
    expect(android).toContain("还没有快捷提示词，请在中台添加");
  });
});
