export function newPlaceholderToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function shouldPersistDesktopJoin(status: number): boolean {
  return status >= 200 && status < 300;
}

export function shouldClearDesktopHub(currentHub: string | null, loopbackHostPort: string): boolean {
  return !!currentHub && currentHub === loopbackHostPort;
}

export function relayDesktopHttp(relay: string, pathname: string, search: string): string {
  const base = relay.replace(/\/+$/, "");
  const path = pathname === "/" ? "/desktop/" : `/desktop${pathname}`;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.delete("token");
  params.delete("desktop");
  const query = params.toString();
  return `${base}${path}${query ? `?${query}` : ""}`;
}

export function relayDesktopWs(relay: string): string {
  const url = new URL(relay);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/desktop/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function desktopPlaceholderOk(search: string, authorization: string | null, placeholder: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("token") === placeholder) return true;
  return authorization === `Bearer ${placeholder}`;
}
