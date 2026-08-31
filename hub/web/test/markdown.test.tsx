import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown } from "../src/components/ChatThread";

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
