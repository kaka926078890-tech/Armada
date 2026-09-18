import { appendSnippetBody, snippetOperatorMessage } from "../src/promptSnippets";
test("append rules", () => {
  expect(appendSnippetBody("", "foo")).toBe("foo");
  expect(appendSnippetBody("hi", "foo")).toBe("hi\nfoo");
  expect(appendSnippetBody("hi\n", "foo")).toBe("hi\nfoo");
  expect(appendSnippetBody(appendSnippetBody("hi", "foo"), "foo")).toBe("hi\nfoo\nfoo");
});

test("operator copy for snippet errors", () => {
  expect(snippetOperatorMessage("SNIPPET_INVALID")).toBe("标题和提示词都不能为空，且不要超长");
  expect(snippetOperatorMessage("SNIPPET_LIMIT")).toBe("最多 30 条快捷提示词");
  expect(snippetOperatorMessage("READ_FAIL")).toBe("读取快捷提示词失败");
  expect(snippetOperatorMessage("WRITE_FAIL")).toBe("保存失败，请重试");
  expect(snippetOperatorMessage(new Error("SNIPPET_INVALID"))).toBe("标题和提示词都不能为空，且不要超长");
});
