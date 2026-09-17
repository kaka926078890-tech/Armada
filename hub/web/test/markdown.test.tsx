import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ChatThread, { AssistantMarkdown, askContinueLabel, askSkipLabel, isPlanAskOptions } from "../src/components/ChatThread";
import type { ChatBlock } from "../src/chatView";

describe("AssistantMarkdown", () => {
  test("renders bold, lists, and gfm tables", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown text={"是的，**findesk 已经拉过**\n\n- 领先 5\n\n| 仓 | 结果 |\n| --- | --- |\n| findesk | 已 rebase |\n"} />,
    );
    expect(html).toContain("<strong");
    expect(html).toContain("<li");
    expect(html).toContain("<table");
    expect(html).toContain("findesk");
  });

  test("single Enter becomes a hard break", () => {
    const html = renderToStaticMarkup(<AssistantMarkdown text={"第一行\n第二行"} />);
    expect(html).toContain("<br");
  });
});

describe("user bubble markdown", () => {
  test("renders headings, lists, and Shift+Enter line breaks", () => {
    const blocks: ChatBlock[] = [{
      kind: "user",
      seq: 1,
      text: "### 标题\n第一行\n第二行\n\n- a\n- b",
    }];
    const html = renderToStaticMarkup(<ChatThread blocks={blocks} />);
    expect(html).toContain("<h3");
    expect(html).toContain("标题");
    expect(html).toContain("<li");
    expect(html).toContain("<br");
    expect(html).not.toContain("### 标题");
  });

  test("ask card prompt renders markdown line breaks", () => {
    const blocks: ChatBlock[] = [{
      kind: "ask",
      seq: 1,
      request_id: "ask-1",
      prompt: "选一个\n第二行",
      options: [{ id: "a", label: "A", text: "甲" }],
      action: "resolved",
    }];
    const html = renderToStaticMarkup(<ChatThread blocks={blocks} />);
    expect(html).toContain("<br");
    expect(html).toContain("选一个");
  });
});

describe("ask / plan action buttons", () => {
  test("plan Build matches Cursor yellow split-button size, not a 12px chip", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "plan-1",
          prompt: "Created Plan: Markdown date line",
          options: [{ id: "build", label: "Build", text: "overview" }],
          action: "pending",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("Build");
    expect(html).toContain("min-h-9");
    expect(html).toContain("min-w-[128px]");
    expect(html).toContain("#F1B467");
    expect(html).toContain("border-l-[#F1B467]");
    expect(html).not.toContain("px-2.5 py-1");
    expect(html).not.toContain("Building...");
  });

  test("submitting plan shows Building... spinner until the ask clears", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "plan-1",
          prompt: "Created Plan: Markdown date line",
          options: [{ id: "build", label: "Build", text: "overview" }],
          action: "submitting",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("Building...");
    expect(html).toContain("animate-spin");
    expect(html).toContain("aria-busy");
  });

  test("step-mode Continue matches Cursor accent size and large option rows", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "ask-1",
          prompt: "选一个",
          options: [{ id: "a", label: "A", text: "甲" }, { id: "b", label: "B", text: "乙" }],
          action: "pending",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("Continue");
    expect(html).toContain("Skip");
    expect(html).toContain("min-h-9");
    expect(html).toContain("min-h-11");
    expect(html).toContain("#599CE7");
    expect(html).not.toContain("px-2.5 py-1");
  });

  test("labels match Cursor Building... / Continuing... while in-flight", () => {
    expect(isPlanAskOptions([{ id: "build" }])).toBe(true);
    expect(isPlanAskOptions([{ id: "a" }])).toBe(false);
    expect(askContinueLabel(true, false)).toBe("Build");
    expect(askContinueLabel(true, true)).toBe("Building...");
    expect(askContinueLabel(false, false)).toBe("Continue");
    expect(askContinueLabel(false, true)).toBe("Continuing...");
    expect(askSkipLabel(false)).toBe("Skip");
    expect(askSkipLabel(true)).toBe("Skipping...");
  });
});
