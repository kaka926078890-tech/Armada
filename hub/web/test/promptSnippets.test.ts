import { appendSnippetBody } from "../src/promptSnippets";
test("append rules", () => {
  expect(appendSnippetBody("", "foo")).toBe("foo");
  expect(appendSnippetBody("hi", "foo")).toBe("hi\nfoo");
  expect(appendSnippetBody("hi\n", "foo")).toBe("hi\nfoo");
  expect(appendSnippetBody(appendSnippetBody("hi", "foo"), "foo")).toBe("hi\nfoo\nfoo");
});
