import { hubWsUrl, loadEventsForSnap, loadRelayConfig, runToSnap, type RelayConfig, type RunSnap } from "./relayClient";
import { createRelayCommandHandler, startRelayHeartbeat } from "./relayCommandHandler";
import type { RunEvent } from "../web/src/types";

/** Attach a hub that only speaks HTTP/SSE (packaged 0.1.0) to a local relay. */
export function startRelayAttach(opts: {
  home: string;
  hubPort: number;
  token: string;
}): { stop: () => void } | null {
  const cfg = loadRelayConfig(opts.home);
  if (!cfg) return null;
  return attachWithConfig(cfg, opts);
}

export function attachWithConfig(
  cfg: RelayConfig,
  opts: { hubPort: number; token: string; pollMs?: number },
): { stop: () => void } {
  let stopped = false;
  let ws: WebSocket | null = null;
  let heartbeat: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let backoff = 1000;
  let connGen = 0;
  const pollMs = Math.max(50, opts.pollMs ?? 2000);
  const lastRunFp = new Map<string, string>();
  let lastMachinesFp = "";

  const hubFetch = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${opts.hubPort}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
        ...(init?.headers ?? {}),
      },
    });

  const send = (msg: object) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const snapOf = async (runId: string): Promise<RunSnap | null> => {
    const runRes = await hubFetch(`/api/runs/${encodeURIComponent(runId)}`);
    const run = await runRes.json().catch(() => null) as any;
    if (!run?.id) return null;
    if (!loadEventsForSnap(String(run.status ?? ""))) return runToSnap(run, []);
    const events = await (await hubFetch(`/api/runs/${encodeURIComponent(runId)}/events`)).json().catch(() => []) as RunEvent[];
    return runToSnap(run, Array.isArray(events) ? events : []);
  };

  const fpOf = (row: any) =>
    `${row.status ?? ""}|${row.ended_at ?? ""}|${row.prompt ?? ""}|${JSON.stringify(row.pending_ask ?? null)}|${JSON.stringify(row.outbound ?? [])}|${row.archived_at ?? ""}|${row.finalText ?? row.final_text ?? ""}`;

  const pushWorkspaces = async (machines?: any[], cursorReload?: unknown) => {
    const list = machines ?? await (await hubFetch("/api/machines")).json().catch(() => null);
    if (!Array.isArray(list)) return;
    const reload = cursorReload ?? await (await hubFetch("/api/cursor-reload")).json().catch(() => null);
    send({ type: "snap.workspaces", machines: list, ...(reload && typeof reload === "object" ? { cursorReload: reload } : {}) });
  };

  const pushRun = async (runId: string) => {
    const run = await snapOf(runId);
    if (run) send({ type: "snap.run", run });
  };

  const pollHub = async () => {
    if (stopped || polling || !ws || ws.readyState !== WebSocket.OPEN) return;
    polling = true;
    try {
      const machines = await (await hubFetch("/api/machines")).json().catch(() => null);
      const reload = await (await hubFetch("/api/cursor-reload")).json().catch(() => null);
      if (Array.isArray(machines)) {
        const fp = JSON.stringify({
          machines: machines.map((m: any) => [m.id, m.status, m.open_workspaces ?? m.openWorkspaces, m.cdp_ready ?? null, m.extension_version ?? m.extensionVersion ?? null]),
          reload,
        });
        if (fp !== lastMachinesFp) {
          lastMachinesFp = fp;
          await pushWorkspaces(machines, reload);
        }
      }
      const runs = await (await hubFetch("/api/runs")).json().catch(() => null);
      if (!Array.isArray(runs)) return;
      const visible = new Set<string>();
      for (const row of runs.slice(0, 30)) {
        if (typeof row?.id !== "string") continue;
        visible.add(row.id);
        const snap = loadEventsForSnap(String(row.status ?? "")) ? await snapOf(row.id) : null;
        const fp = fpOf({ ...row, finalText: snap?.finalText ?? "" });
        if (lastRunFp.get(row.id) === fp) continue;
        lastRunFp.set(row.id, fp);
        if (snap) send({ type: "snap.run", run: snap });
        else await pushRun(row.id);
      }
      for (const id of [...lastRunFp.keys()]) {
        if (visible.has(id)) continue;
        const row = await (await hubFetch(`/api/runs/${encodeURIComponent(id)}`)).json().catch(() => null);
        if (!row?.id) continue;
        const snap = loadEventsForSnap(String(row.status ?? "")) ? await snapOf(row.id) : null;
        const fp = fpOf({ ...row, finalText: snap?.finalText ?? "" });
        if (lastRunFp.get(id) === fp) continue;
        lastRunFp.set(id, fp);
        if (snap) send({ type: "snap.run", run: snap });
        else await pushRun(id);
      }
    } finally {
      polling = false;
    }
  };

  const schedulePoll = () => {
    if (stopped) return;
    pollTimer = setTimeout(() => { void pollHub().then(schedulePoll); }, pollMs);
  };

  const onCommand = createRelayCommandHandler({ hubFetch, snapOf, send });

  const connect = () => {
    if (stopped) return;
    const gen = ++connGen;
    const next = new WebSocket(hubWsUrl(cfg));
    ws = next;
    next.addEventListener("open", () => {
      if (gen !== connGen) return;
      backoff = 1000;
      lastRunFp.clear();
      lastMachinesFp = "";
      heartbeat?.();
      heartbeat = startRelayHeartbeat(next);
      void pollHub();
    });
    next.addEventListener("message", (e) => {
      if (gen !== connGen) return;
      let msg: any;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      void onCommand(msg);
    });
    const retry = () => {
      heartbeat?.(); heartbeat = null;
      if (gen !== connGen || stopped) return;
      const wait = backoff;
      backoff = Math.min(30_000, backoff * 2);
      reconnectTimer = setTimeout(connect, wait);
    };
    next.addEventListener("close", retry);
    next.addEventListener("error", () => { try { next.close(); } catch { /* ignore */ } });
  };

  connect();
  schedulePoll();
  return {
    stop() {
      stopped = true;
      connGen++;
      heartbeat?.();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearTimeout(pollTimer);
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
