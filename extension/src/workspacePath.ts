/** Compare workspace roots across Windows slash / drive-letter / Git-bash forms. */
export function normalizeWorkspacePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  const msys = /^\/([A-Za-z])(?::|\/)(.*)$/.exec(s);
  if (msys) {
    const rest = msys[2].replace(/^\/+/, "");
    s = `${msys[1]}:/${rest}`.replace(/\/{2,}/g, "/");
  }
  if (/^[A-Za-z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  while (s.length > 3 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

export function workspacePathsEqual(a: string, b: string): boolean {
  return normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
}

export function workspacePathIn(path: string, roots: string[]): boolean {
  return roots.some((r) => workspacePathsEqual(r, path));
}
