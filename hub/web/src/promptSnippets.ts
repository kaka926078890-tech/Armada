export function appendSnippetBody(current: string, body: string): string {
  const b = body.trimEnd();
  if (!current) return b;
  return current.endsWith("\n") ? current + b : current + "\n" + b;
}
