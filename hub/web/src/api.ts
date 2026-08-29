export function getToken(): string { return localStorage.getItem("armada.token") ?? ""; }
export function setToken(t: string): void { localStorage.setItem("armada.token", t); }

async function req(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}`, ...(init?.headers ?? {}) } });
  if (r.status === 401) { window.dispatchEvent(new Event("armada:unauthorized")); throw new Error("unauthorized"); }
  return r;
}

export const api = {
  machines: () => req("/api/machines").then((r) => r.json()),
  runs: () => req("/api/runs").then((r) => r.json()),
  run: (id: string) => req(`/api/runs/${id}`).then((r) => r.json()),
  events: (id: string, afterSeq = 0) => req(`/api/runs/${id}/events?afterSeq=${afterSeq}`).then((r) => r.json()),
  dispatch: (machineId: string, workspaceRoot: string, prompt: string) =>
    req("/api/runs", { method: "POST", body: JSON.stringify({ machineId, workspaceRoot, prompt }) }).then((r) => r.json()),
  cancel: (id: string) => req(`/api/runs/${id}/cancel`, { method: "POST" }).then((r) => r.json()),
  followup: (id: string, prompt: string) => req(`/api/runs/${id}/followup`, { method: "POST", body: JSON.stringify({ prompt }) }).then((r) => r.json()),
  close: (id: string) => req(`/api/runs/${id}/close`, { method: "POST" }).then((r) => r.json()),
  streamUrl: (id: string) => `/api/runs/${id}/stream?token=${encodeURIComponent(getToken())}`,
};
