import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ChatThread, { AssistantMarkdown, askContinueAnswers, askContinueLabel, askSkipLabel, continueAllowed, isPlanAsk, planOverviewOf } from "../src/components/ChatThread";
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

  test("user bubble with imageIds shows a Cursor-sized thumb and hides [图片]", () => {
    const html = renderToStaticMarkup(
      <ChatThread blocks={[{ kind: "user", seq: 1, text: "[图片] 看这张", imageIds: ["abc"] }]} />,
    );
    expect(html).toContain("size-36");
    expect(html).toContain("rounded-xl");
    expect(html).toContain("查看 图片");
    expect(html).toContain("看这张");
    expect(html).not.toContain("[图片]");
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
  test("plan Build uses the shared 32px control, not a 12px chip or 44px row", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "plan-1",
          prompt: "Created Plan: Markdown date line",
          askKind: "plan",
          options: [{ id: "build", label: "Build", text: "overview" }],
          action: "pending",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("Build");
    expect(html).toContain("h-8");
    expect(html).toContain("#F1B467");
    expect(html).toContain("border-l-[#F1B467]");
    expect(html).not.toContain("min-h-11");
    expect(html).not.toContain("min-h-9");
    expect(html).not.toContain("min-w-[128px]");
    expect(html).not.toContain("Building...");
    expect(html).toContain("overview");
  });

  test("submitting plan shows Building... spinner until the ask clears", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "plan-1",
          prompt: "Created Plan: Markdown date line",
          askKind: "plan",
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

  test("step-mode Continue / Skip / options share the 32px control", () => {
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
    expect(html).toContain("h-8");
    expect(html).toContain("min-h-8");
    expect(html).toContain("#599CE7");
    expect(html).not.toContain("min-h-11");
    expect(html).not.toContain("min-h-9");
  });

  test("labels match Cursor Building... / Continuing... while in-flight", () => {
    expect(isPlanAsk({ askKind: "plan" })).toBe(true);
    expect(isPlanAsk({ askKind: undefined })).toBe(false);
    expect(isPlanAsk({})).toBe(false);
    expect(askContinueLabel(true, false)).toBe("Build");
    expect(askContinueLabel(true, true)).toBe("Building...");
    expect(askContinueLabel(false, false)).toBe("Continue");
    expect(askContinueAnswers({ askKind: "plan", options: [{ id: "build" }] }, "")).toEqual([
      { question_id: "q0", option_ids: ["build"] },
    ]);
    expect(askContinueAnswers({ options: [{ id: "a" }] }, "a")).toEqual([
      { question_id: "q0", option_ids: ["a"] },
    ]);
    expect(askContinueAnswers({ options: [{ id: "a" }] }, "")).toEqual([]);
    expect(askContinueLabel(false, true)).toBe("Continuing...");
    expect(askSkipLabel(false)).toBe("Skip");
    expect(askSkipLabel(true)).toBe("Skipping...");
  });

  test("single option id=build without kind is not plan", () => {
    expect(isPlanAsk({ askKind: undefined })).toBe(false);
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "ask-1",
          prompt: "选一个",
          options: [{ id: "build", label: "B", text: "one" }],
          action: "pending",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("Questions");
    expect(html).toContain("Continue");
    expect(html).not.toContain("Created Plan");
    expect(html).not.toContain("border-l-[#F1B467]");
    expect(html).toContain("#599CE7");
  });

  test("kind=plan with a non-build option id is still plan", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "plan-1",
          prompt: "Created Plan: other id",
          askKind: "plan",
          options: [{ id: "go", label: "Go", text: "overview body" }],
          action: "pending",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("Created Plan");
    expect(html).toContain("Build");
    expect(html).toContain("border-l-[#F1B467]");
    expect(html).toContain("overview body");
    expect(html).not.toContain("Continue");
  });

  test("two questions hide Continue", () => {
    expect(continueAllowed({ continueAllowed: true })).toBe(true);
    expect(continueAllowed({ continueAllowed: false })).toBe(false);
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "ask-2",
          prompt: "第一问",
          options: [{ id: "a", label: "A", text: "甲" }],
          action: "pending",
          continueAllowed: false,
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("Skip");
    expect(html).not.toContain("Continue");
  });

  test("repeated letter ids hide the shared picker", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "ask-collide",
          prompt: "上传成功后，用户在哪里问这个知识库？",
          options: [
            { id: "a", label: "A", text: "第一题甲" },
            { id: "b", label: "B", text: "第一题乙" },
            { id: "a", label: "A", text: "第二题甲" },
          ],
          action: "pending",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("逐题作答");
    expect(html).toContain("Skip");
    expect(html).not.toContain("Continue");
    expect(html).not.toContain("第一题甲");
  });

  test("Ask card shows A/B/C and D Other like Cursor, without duplicating the letter", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "ask-1",
          prompt: "选一个",
          options: [
            { id: "a", label: "A", text: "A：芯片只显示 A/B/C" },
            { id: "b", label: "B", text: "乙" },
            { id: "c", label: "C", text: "丙" },
          ],
          action: "pending",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain(">A</span>");
    expect(html).toContain("芯片只显示 A/B/C");
    expect(html).not.toContain("A：芯片只显示");
    expect(html).toMatch(/>D<\/span>/);
    expect(html).toContain("Other...");
    expect(html).not.toContain("placeholder=\"Other...\"");
    expect(html).toContain("Continue");
    expect(html).toContain("Skip");
  });

  test("plan card renders captured overview, not just Created Plan filename", () => {
    expect(planOverviewOf({ askKind: "plan", options: [{ id: "build", text: "同一分支继续完成内嵌通道修复" }] })).toBe("同一分支继续完成内嵌通道修复");
    expect(planOverviewOf({ askKind: "plan", options: [{ id: "build", text: "Build" }] })).toBe("");
    expect(planOverviewOf({ options: [{ id: "build", text: "同一分支继续完成内嵌通道修复" }] })).toBe("");
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "plan-1",
          prompt: "Created Plan: Dual Browser Channels",
          askKind: "plan",
          options: [{ id: "build", label: "Build", text: "同一分支继续完成内嵌通道修复，并并列接入腾讯 BrowserSkill。" }],
          action: "pending",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("Created Plan: Dual Browser Channels");
    expect(html).toContain("同一分支继续完成内嵌通道修复，并并列接入腾讯 BrowserSkill。");
  });

  test("plan card renders the plan file markdown body, not only the one-line overview", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{
          kind: "ask",
          seq: 1,
          request_id: "plan-1",
          prompt: "Created Plan: Markdown date line",
          askKind: "plan",
          options: [{ id: "build", label: "Build", text: "# 在 markdown 追加日期\n\n在任意一份现有 markdown 末尾追加一行。" }],
          action: "pending",
        }]}
        onAnswerAsk={async () => true}
      />,
    );
    expect(html).toContain("在 markdown 追加日期");
    expect(html).toContain("max-h-80");
  });
});

describe("workspace file links", () => {
  test("md links intercept when onOpenFile is set", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[{ kind: "assistant", seq: 1, text: "[spec](docs/foo.md)" }]}
        onOpenFile={() => {}}
      />,
    );
    expect(html).toContain("docs/foo.md");
    expect(html).toContain("spec");
    expect(html).not.toContain("target=\"_blank\"");
  });

  test("http links stay external", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown text={"[docs](https://example.com/foo.md)"} onOpenFile={() => {}} />,
    );
    expect(html).toContain("https://example.com/foo.md");
    expect(html).toContain("target=\"_blank\"");
  });
});

describe("Cursor-like tool fold", () => {
  test("collapsed process header shows merged Read count, not 1250 rows", () => {
    const html = renderToStaticMarkup(
      <ChatThread
        blocks={[
          { kind: "user", seq: 1, text: "打包" },
          { kind: "tool", seq: 2, name: "Read", summary: "Read · 552282.txt", count: 1250 },
        ]}
      />,
    );
    expect(html).toContain("思考过程 · Read · 552282.txt × 1250");
    expect(html).not.toContain("思考过程 · 1250 步");
    const reads = html.split("Read · 552282.txt");
    expect(reads.length).toBe(2);
  });
});
