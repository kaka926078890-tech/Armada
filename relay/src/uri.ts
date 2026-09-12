export type PairInvite = { kind: "pair"; relay: string; fleet: string; secret: string };
export type OpInvite = { kind: "op"; relay: string; fleet: string; token: string };
export type RelayInvite = PairInvite | OpInvite;
export type RelayUriError = { error: "invalid" | "incomplete" | "insecure" };

const FLEET_RE = /^[a-z0-9-]{8,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/** Production requires https. Loopback http is allowed so the iOS Simulator can hit a local relay. */
export function originOf(relay: string): string | null {
  try {
    const u = new URL(relay);
    if (u.protocol === "https:") return `${u.protocol}//${u.host}`;
    if (u.protocol === "http:" && isLoopback(u.hostname)) return `${u.protocol}//${u.host}`;
    return null;
  } catch {
    return null;
  }
}

export function formatPairUri(relay: string, fleet: string, secret: string): string {
  const q = new URLSearchParams({ relay, fleet, secret });
  return `armada-relay://pair?${q}`;
}

export function formatOpUri(relay: string, fleet: string, token: string): string {
  const q = new URLSearchParams({ relay, fleet, token });
  return `armada-relay://op?${q}`;
}

export function parseRelayUri(input: string): RelayInvite | RelayUriError {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: "invalid" };
  }
  if (url.protocol !== "armada-relay:") return { error: "invalid" };
  const path = `${url.hostname}${url.pathname}`.replace(/\/+$/, "");
  const kind = path === "pair" || path === "//pair" ? "pair"
    : path === "op" || path === "//op" ? "op"
    : null;
  if (!kind) return { error: "invalid" };
  const relayRaw = url.searchParams.get("relay")?.trim() ?? "";
  const fleet = url.searchParams.get("fleet")?.trim() ?? "";
  if (!relayRaw || !fleet) return { error: "incomplete" };
  const origin = originOf(relayRaw);
  if (!origin) return { error: "insecure" };
  if (!FLEET_RE.test(fleet)) return { error: "incomplete" };
  if (kind === "pair") {
    const secret = url.searchParams.get("secret")?.trim() ?? "";
    if (!HEX64.test(secret)) return { error: "incomplete" };
    return { kind: "pair", relay: origin, fleet, secret };
  }
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!HEX64.test(token)) return { error: "incomplete" };
  return { kind: "op", relay: origin, fleet, token };
}

export function encodeWorkspaceId(machineId: string, workspaceRoot: string): string {
  return `${machineId}|${workspaceRoot}`;
}

export function decodeWorkspaceId(id: string): { machineId: string; workspaceRoot: string } | null {
  const i = id.indexOf("|");
  if (i <= 0) return null;
  const machineId = id.slice(0, i);
  const workspaceRoot = id.slice(i + 1);
  if (!machineId || !workspaceRoot) return null;
  return { machineId, workspaceRoot };
}
