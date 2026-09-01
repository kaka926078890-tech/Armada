export type JoinUri = { hubHost: string; hubPort: number; token: string; hubHostPort: string };

function stripHub(raw: string): { host: string; port: number } {
  let s = raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const idx = s.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(s.slice(idx + 1))) {
    return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) };
  }
  return { host: s, port: 7380 };
}

export function parseJoinUri(input: string): JoinUri | { error: "incomplete" | "invalid" } {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "invalid" };
  }
  if (url.protocol !== "armada:") return { error: "invalid" };
  const path = `${url.hostname}${url.pathname}`.replace(/\/+$/, "");
  if (path !== "join" && path !== "//join") return { error: "invalid" };
  const hubRaw = url.searchParams.get("hub");
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!hubRaw || !token) return { error: "incomplete" };
  const { host, port } = stripHub(hubRaw);
  if (!host) return { error: "incomplete" };
  return { hubHost: host, hubPort: port, token, hubHostPort: `${host}:${port}` };
}

export function formatJoinUri(hubHostPort: string, token: string): string {
  return `armada://join?hub=${hubHostPort}&token=${token}`;
}
