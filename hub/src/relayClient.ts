import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { decodeWorkspaceId, originOf } from "../../relay/src/uri";
import { assistantBodyText, eventsToChat } from "../web/src/chatView";
import type { RunEvent } from "../web/src/types";
import type { Registry } from "./registry";
import type { RunService } from "./runs";
import type { SseHub } from "./sse";

const HEX64 = /^[a-f0-9]{64}$/;
const FLEET_RE = /^[a-z0-9-]{8,64}$/;
const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

export type RelayConfig = { relay: string; fleet: string; secret: string };

export type RunSnap = {
  runId: string;
  machineId: string;
  workspaceRoot: string;
  prompt: string;
  status: string;
  finalText?: string | null;
  error?: string | null;
  pendingAsk?: unknown;
  updatedAt: number;
};

export function loadRelayConfig(home: string): RelayConfig | null {
  const p = join(home, "relay.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const origin = typeof j.relay === "string" ? originOf(j.relay) : null;
    const fleet = typeof j.fleet === "string" ? j.fleet.trim() : "";
    const secret = typeof j.secret === "string" ? j.secret.trim() : "";
    if (!origin || !FLEET_RE.test(fleet) || !HEX64.test(secret)) return null;
    return { relay: origin, fleet, secret };
  } catch {
    return null;
  }
}

export function hubWsUrl(cfg: RelayConfig): string {
  const u = new URL("/hub", cfg.relay);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("fleet", cfg.fleet);
  u.searchParams.set("secret", cfg.secret);
  return u.toString();
}

export function runToSnap(run: any, events: RunEvent[]): RunSnap {
  const body = assistantBodyText(eventsToChat(events));
  let status = String(run.status ?? "unknown");
  let error = (run.end_reason as string | null) ?? null;
  let finalText: string | null = null;
  if (status === "completed") {
    if (body.length > 0) finalText = body;
    else {
      status = "error";
      error = "NO_ASSISTANT_BODY";
    }
  }
  return {
    runId: run.id,
    machineId: run.machine_id,
    workspaceRoot: run.workspace_root,
    prompt: run.prompt ?? "",
    status,
    finalText,
    error,
    pendingAsk: run.pending_ask ?? null,
    updatedAt: Number(run.ended_at ?? run.started_at ?? run.created_at ?? Date.now()),
  };
}

export function startRelayClient(opts: {
  home: string;
  hubPort: number;
  token: string;
  registry: Registry;
  runs: RunService;
  db: Database;
  sse: SseHub;
}): { stop: () => void } | null {
  const cfg = loadRelayConfig(opts.home);
  if (!cfg) return null;

  let stopped = false;
  let ws: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;

  const eventsFor = (runId: string) =>
    opts.db.query("SELECT * FROM run_events WHERE run_id=?1 ORDER BY seq").all(runId) as RunEvent[];

  const snapOf = (runId: string): RunSnap | null => {
    const run = opts.runs.get(runId);
    if (!run) return null;
    return runToSnap(run, eventsFor(runId));
  };

  const send = (msg: object) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const pushWorkspaces = () => {
    send({ type: "snap.workspaces", machines: opts.registry.listMachines() });
  };

  const pushRun = (runId: string) => {
    const run = snapOf(runId);
    if (run) send({ type: "snap.run", run });
  };

  const prevMachines = opts.registry.onMachinesChanged;
  opts.registry.onMachinesChanged = () => {
    prevMachines?.();
    pushWorkspaces();
  };

  const prevEvent = opts.sse.onEvent;
  opts.sse.onEvent = (runId, event) => {
    prevEvent?.(runId, event);
    const t = (event as { type?: string }).type;
    if (t === "machine.updated") pushWorkspaces();
    if (t === "run.status" || t === "run.ask") pushRun(runId);
  };

  const hubFetch = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${opts.hubPort}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
        ...(init?.headers ?? {}),
      },
    });

  const onCommand = async (msg: any) => {
    const requestId = msg.requestId;
    const fail = (error: string) => send({ type: "cmd.result", requestId, ok: false, error });
    try {
      if (msg.type === "cmd.dispatch") {
        const decoded = typeof msg.workspaceId === "string" ? decodeWorkspaceId(msg.workspaceId) : null;
        if (!decoded) return fail("INVALID");
        const r = await hubFetch("/api/runs", {
          method: "POST",
          body: JSON.stringify({ machineId: decoded.machineId, workspaceRoot: decoded.workspaceRoot, prompt: msg.prompt ?? "" }),
        });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        const run = snapOf(body.run.id);
        send({ type: "cmd.result", requestId, ok: true, run });
        if (run) send({ type: "snap.run", run });
        return;
      }
      if (msg.type === "cmd.answer") {
        const r = await hubFetch(`/api/runs/${encodeURIComponent(msg.runId)}/answer-ask`, {
          method: "POST",
          body: JSON.stringify(msg.body ?? {}),
        });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        const run = snapOf(msg.runId);
        send({ type: "cmd.result", requestId, ok: true, run });
        if (run) send({ type: "snap.run", run });
        return;
      }
      if (msg.type === "cmd.cancel") {
        const r = await hubFetch(`/api/runs/${encodeURIComponent(msg.runId)}/cancel`, { method: "POST" });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        const run = snapOf(msg.runId);
        send({ type: "cmd.result", requestId, ok: true, run });
        if (run) send({ type: "snap.run", run });
      }
    } catch {
      fail("HUB_ERROR");
    }
  };

  const connect = () => {
    if (stopped) return;
    const next = new WebSocket(hubWsUrl(cfg));
    ws = next;
    next.addEventListener("open", () => {
      backoff = 1000;
      pushWorkspaces();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        try { next.ping(); } catch { /* ignore */ }
      }, HEARTBEAT_MS);
    });
    next.addEventListener("message", (e) => {
      let msg: any;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      void onCommand(msg);
    });
    const retry = () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (stopped) return;
      const wait = backoff;
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      reconnectTimer = setTimeout(connect, wait);
    };
    next.addEventListener("close", retry);
    next.addEventListener("error", () => { try { next.close(); } catch { /* ignore */ } });
  };

  connect();
  return {
    stop() {
      stopped = true;
      opts.registry.onMachinesChanged = prevMachines;
      opts.sse.onEvent = prevEvent;
      if (heartbeat) clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
