export function consumeQueryToken(search: string, currentToken: string): { token: string; stripQuery: boolean } {
  const q = search.startsWith("?") ? search.slice(1) : search;
  const token = new URLSearchParams(q).get("token")?.trim() ?? "";
  if (token) return { token, stripQuery: true };
  return { token: currentToken, stripQuery: false };
}

export function searchWithoutToken(search: string): string {
  const q = search.startsWith("?") ? search.slice(1) : search;
  const p = new URLSearchParams(q);
  p.delete("token");
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function isDesktopShell(search: string): boolean {
  const q = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(q).get("desktop") === "1";
}
