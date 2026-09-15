import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ChatThread, { AssistantMarkdown } from "../src/components/ChatThread";
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
});
