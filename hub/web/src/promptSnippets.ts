export function appendSnippetBody(current: string, body: string): string {
  const b = body.trimEnd();
  if (!current) return b;
  return current.endsWith("\n") ? current + b : current + "\n" + b;
}

const SNIPPET_OPERATOR_COPY: Record<string, string> = {
  SNIPPET_INVALID: "标题和提示词都不能为空，且不要超长",
  SNIPPET_LIMIT: "最多 30 条快捷提示词",
  READ_FAIL: "读取快捷提示词失败",
  WRITE_FAIL: "保存失败，请重试",
};

export function snippetOperatorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = raw.replace(/^Error:\s*/, "").trim();
  return SNIPPET_OPERATOR_COPY[code] ?? raw;
}
