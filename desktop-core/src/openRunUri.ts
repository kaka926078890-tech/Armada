export type OpenRunUri = {
  runId: string;
  machineId: string;
  workspaceRoot: string;
};

export function parseOpenRunUri(input: string): OpenRunUri | { error: "incomplete" | "invalid" } {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "invalid" };
  }
  if (url.protocol !== "armada:") return { error: "invalid" };
  const path = `${url.hostname}${url.pathname}`.replace(/\/+$/, "");
  if (path !== "open-run" && path !== "//open-run") return { error: "invalid" };
  const runId = url.searchParams.get("runId")?.trim() ?? "";
  const machineId = url.searchParams.get("machineId")?.trim() ?? "";
  const workspaceRoot = url.searchParams.get("root")?.trim() ?? "";
  if (!runId || !machineId || !workspaceRoot) return { error: "incomplete" };
  return { runId, machineId, workspaceRoot };
}

export function formatOpenRunUri(payload: OpenRunUri): string {
  const p = new URLSearchParams();
  p.set("runId", payload.runId);
  p.set("machineId", payload.machineId);
  p.set("root", payload.workspaceRoot);
  return `armada://open-run?${p.toString()}`;
}

export function firstArmadaOpenRun(urls: string[]): OpenRunUri | null {
  for (const u of urls) {
    const parsed = parseOpenRunUri(u.trim());
    if (!("error" in parsed)) return parsed;
  }
  return null;
}
