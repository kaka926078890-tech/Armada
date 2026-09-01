export type ProbeResult = {
  connectivity: "ok" | "fail";
  auth: "ok" | "unauthorized" | "skipped";
  healthName?: string;
};

export async function probeHub(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const root = baseUrl.replace(/\/+$/, "");
  let health: Response;
  try {
    health = await fetchImpl(`${root}/api/health`);
  } catch {
    return { connectivity: "fail", auth: "skipped" };
  }
  if (!health.ok) return { connectivity: "fail", auth: "skipped" };
  const hj = await health.json().catch(() => ({})) as { name?: string };
  const healthName = typeof hj.name === "string" ? hj.name : undefined;
  if (healthName !== "armada-hub") return { connectivity: "fail", auth: "skipped", healthName };
  const machines = await fetchImpl(`${root}/api/machines`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (machines.status === 401) return { connectivity: "ok", auth: "unauthorized", healthName };
  if (!machines.ok) return { connectivity: "fail", auth: "skipped", healthName };
  return { connectivity: "ok", auth: "ok", healthName };
}

export function mayWriteCursorSettings(p: ProbeResult): boolean {
  return p.connectivity === "ok" && p.auth === "ok";
}
