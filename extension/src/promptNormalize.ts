export function normalizePrompt(s: string): string {
  return s.replace(/\r/g, "").trim().replace(/\s+/g, " ");
}
