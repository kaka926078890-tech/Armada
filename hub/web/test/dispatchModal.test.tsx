import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DispatchModal } from "../src/components/Modals";
import { ConsoleFilePicker } from "../src/components/ConsoleFilePicker";
import { CDP_NOT_READY_COPY } from "../src/boardState";
import type { Machine } from "../src/types";

const machine: Machine = {
  id: "m-1", name: "Win-A", os: "win32", cursor_version: null, extension_version: null,
  open_workspaces: JSON.stringify(["C:/ws"]), status: "online", last_seen_at: 1,
  cdp_ready: true,
};

describe("DispatchModal prompt", () => {
  test("documents Enter dispatch and Shift+Enter newline as markdown source", () => {
    const html = renderToStaticMarkup(
      <DispatchModal
        machines={[machine]}
        preset={{ machineId: "m-1", workspaceRoot: "C:/ws" }}
        activeOnWorkspace={0}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html).toContain("Enter 派发");
    expect(html).toContain("Shift+Enter 换行");
    expect(html).toContain("Markdown 原文");
  });

  test("cdp_ready false lists workspace but blocks dispatch with zombie copy", () => {
    const html = renderToStaticMarkup(
      <DispatchModal
        machines={[{ ...machine, cdp_ready: false }]}
        preset={{ machineId: "m-1", workspaceRoot: "C:/ws" }}
        activeOnWorkspace={0}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html).toContain(CDP_NOT_READY_COPY);
    expect(html).toContain("disabled");
  });

  test("caps dialog and textarea so a long prompt cannot leave the viewport", () => {
    const html = renderToStaticMarkup(
      <DispatchModal
        machines={[machine]}
        preset={{ machineId: "m-1", workspaceRoot: "C:/ws" }}
        activeOnWorkspace={0}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html).toContain("max-h-[min(90dvh,calc(100vh-2rem))]");
    expect(html).toContain("overflow-x-hidden");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("max-h-[min(12rem,40vh)]");
    expect(html).toContain("field-sizing-fixed");
  });

  test("hides the native file control so a long filename cannot open a horizontal scrollbar", () => {
    const html = renderToStaticMarkup(
      <DispatchModal
        machines={[machine]}
        preset={{ machineId: "m-1", workspaceRoot: "C:/ws" }}
        activeOnWorkspace={0}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html).toContain("选择文件");
    expect(html).toContain("sr-only");
    expect(html).not.toContain("Choose Files");
    expect(html).toContain("min-w-0");
  });

  test("picked Feishu jpeg shows an ellipsized name instead of the native filename string", () => {
    const f = new File(
      [new Uint8Array([1])],
      "img_v3_0215n_5cf580dd-ad94-4f31-95b8-477e2325cddg.jpg",
      { type: "image/jpeg" },
    );
    const html = renderToStaticMarkup(<ConsoleFilePicker files={[f]} onFiles={() => {}} />);
    expect(html).toContain("sr-only");
    expect(html).toContain("min-w-0");
    expect(html).toContain("truncate");
    expect(html).toContain(">img_v3_0215n_5cf580dd-ad94-4f31….jpg<");
    expect(html).toContain(`title="img_v3_0215n_5cf580dd-ad94-4f31-95b8-477e2325cddg.jpg"`);
  });

  test("shows prompt snippet bar above the textarea without submitting", () => {
    const html = renderToStaticMarkup(
      <DispatchModal
        machines={[machine]}
        preset={{ machineId: "m-1", workspaceRoot: "C:/ws" }}
        activeOnWorkspace={0}
        snippets={[{ id: "ok-id-01", title: "规范", body: "先写测试" }]}
        saveSnippets={async () => {}}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html).toContain('aria-label="添加快捷提示词"');
    expect(html).toContain("规范");
    const addAt = html.indexOf('aria-label="添加快捷提示词"');
    const taAt = html.indexOf("提示词（Markdown 原文");
    expect(addAt).toBeGreaterThan(-1);
    expect(taAt).toBeGreaterThan(addAt);
  });
});
