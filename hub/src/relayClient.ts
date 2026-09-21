import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { originOf } from "../../relay/src/uri";
import { eventsToChat, lastTurnAssistantBody } from "../web/src/chatView";
import { runDisplayName } from "../web/src/boardState";
import type { RunEvent } from "../web/src/types";
import { canRetryStatus, LIVE_STATUSES, TERMINAL_STATUSES } from "./concurrency";
import { createRelayCommandHandler, startRelayHeartbeat } from "./relayCommandHandler";
import { cursorReloadView } from "./cursorReloadStore";
import type { Registry } from "./registry";
import type { RunService } from "./runs";
import type { SseHub } from "./sse";

const HEX64 = /^[a-f0-9]{64}$/;
const FLEET_RE = /^[a-z0-9-]{8,64}$/;
const MAX_BACKOFF_MS = 30_000;

export type RelayConfig = { relay: string; fleet: string; secret: string };

export type OutboundSnap = {
  id: string;
  prompt: string;
  expectedMode: string;
  state: string;
  createdAt: number;
};

export type SnapAttachment = { id: string; mime: string; name: string; size: number };

export type RunSnap = {
  runId: string;
  machineId: string;
  workspaceRoot: string;
  prompt: string;
  title: string;
  conversationId: string | null;
  status: string;
  finalText?: string | null;
  error?: string | null;
  pendingAsk?: unknown;
  outbound?: OutboundSnap[];
  queueMessageDefaultBehavior?: string | null;
  canRetry?: boolean;
  archived?: boolean;
  attachments?: SnapAttachment[];
  updatedAt: number;
};

export function snapAttachmentsOf(run: any): SnapAttachment[] {
  const raw = Array.isArray(run?.attachment_items) ? run.attachment_items
    : Array.isArray(run?.attachments) && run.attachments.some((x: any) => x && typeof x === "object" && typeof (x.id ?? x.sha256) === "string")
      ? run.attachments
      : [];
  const out: SnapAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id : typeof item.sha256 === "string" ? item.sha256 : "";
    if (!id) continue;
    out.push({
      id,
      mime: typeof item.mime === "string" ? item.mime : "",
      name: typeof item.name === "string" ? item.name : "",
      size: typeof item.size === "number" ? item.size : 0,
    });
  }
  return out;
}

function snapOutbound(raw: unknown): OutboundSnap[] {
  if (!Array.isArray(raw)) return [];
  const out: OutboundSnap[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    const prompt = typeof o.prompt === "string" ? o.prompt : "";
    if (!id || !prompt) continue;
    const expectedMode = typeof o.expectedMode === "string" ? o.expectedMode
      : typeof o.expected_mode === "string" ? o.expected_mode : "";
    const state = typeof o.state === "string" ? o.state : "";
    const createdAt = typeof o.createdAt === "number" ? o.createdAt
      : typeof o.created_at === "number" ? o.created_at : 0;
    out.push({ id, prompt, expectedMode, state, createdAt });
  }
  return out;
}

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

/** Live snaps must not scan transcript jsonl. Terminal + unknown cards may need finalText. */
export function loadEventsForSnap(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status) || status === "unknown";
}

/** Matches relay GET /mobile/runs page size so a reconnect can fully replace the operator list. */
export const RELAY_DUMP_LIMIT = 50;

export type RelayDumpRow = {
  id: string;
  status: string;
  archived_at?: number | null;
  ended_at?: number | null;
  started_at?: number | null;
  created_at?: number | null;
};

function dumpActivityTs(row: RelayDumpRow): number {
  return Number(row.ended_at ?? row.started_at ?? row.created_at ?? 0);
}

/**
 * Runs that must reconverge on hub↔relay open: every live/unknown card, plus the
 * same 50+50 window the phone lists. Stale `running` on relay after MACHINE_OFFLINE
 * is recovered here — live SSE `snap.run` is not durable across a dropped WS.
 */
export function runIdsForRelayDump(rows: RelayDumpRow[], limit = RELAY_DUMP_LIMIT): string[] {
  const live = new Set<string>(LIVE_STATUSES as readonly string[]);
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const row of rows) {
    const status = String(row.status ?? "");
    if (live.has(status) || status === "unknown") add(row.id);
  }
  const byActivity = (a: RelayDumpRow, b: RelayDumpRow) => dumpActivityTs(b) - dumpActivityTs(a);
  const open = rows.filter((r) => !(Number(r.archived_at) > 0)).sort(byActivity).slice(0, limit);
  const hidden = rows.filter((r) => Number(r.archived_at) > 0).sort(byActivity).slice(0, limit);
  for (const row of open) add(row.id);
  for (const row of hidden) add(row.id);
  return ids;
}

export function runToSnap(run: any, events: RunEvent[]): RunSnap {
  const body = lastTurnAssistantBody(eventsToChat(events));
  const status = String(run.status ?? "unknown");
  const error = (run.end_reason as string | null) ?? null;
  const terminal = (TERMINAL_STATUSES as readonly string[]).includes(status) || status === "unknown";
  const finalText = terminal ? (body || null) : null;
  const mode = typeof run.queue_message_default_behavior === "string" ? run.queue_message_default_behavior
    : typeof run.queueMessageDefaultBehavior === "string" ? run.queueMessageDefaultBehavior
    : null;
  const cid = typeof run.conversation_id === "string" && run.conversation_id.trim()
    ? run.conversation_id.trim()
    : null;
  const attachments = snapAttachmentsOf(run);
  return {
    runId: run.id,
    machineId: run.machine_id,
    workspaceRoot: run.workspace_root,
    prompt: run.prompt ?? "",
    title: runDisplayName({ title: run.title, prompt: run.prompt ?? "" }),
    conversationId: cid,
    status,
    finalText,
    error,
    pendingAsk: run.pending_ask ?? null,
    outbound: snapOutbound(run.outbound),
    queueMessageDefaultBehavior: mode,
    canRetry: canRetryStatus(status),
    archived: Number(run.archived_at) > 0,
    ...(attachments.length ? { attachments } : {}),
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
  let heartbeat: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;

  const eventsFor = (runId: string) =>
    opts.db.query("SELECT * FROM run_events WHERE run_id=?1 ORDER BY seq").all(runId) as RunEvent[];

  const snapOf = (runId: string): RunSnap | null => {
    const run = opts.runs.get(runId);
    if (!run) return null;
    return runToSnap(run, loadEventsForSnap(String(run.status ?? "")) ? eventsFor(runId) : []);
  };

  const send = (msg: object) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const pushWorkspaces = () => {
    send({
      type: "snap.workspaces",
      machines: opts.registry.listMachines(),
      cursorReload: cursorReloadView(opts.home, opts.registry.listMachines()),
    });
  };

  const pushRun = (runId: string) => {
    const run = snapOf(runId);
    if (run) send({ type: "snap.run", run });
  };

  const dumpRuns = () => {
    const rows = opts.db.query(
      "SELECT id, status, archived_at, ended_at, started_at, created_at FROM runs",
    ).all() as RelayDumpRow[];
    for (const id of runIdsForRelayDump(rows)) {
      try { pushRun(id); } catch { /* one bad snap must not skip the rest */ }
    }
  };

  const pushSoon = new Map<string, ReturnType<typeof setTimeout>>();
  const schedulePush = (runId: string) => {
    const prev = pushSoon.get(runId);
    if (prev) clearTimeout(prev);
    pushSoon.set(runId, setTimeout(() => {
      pushSoon.delete(runId);
      pushRun(runId);
    }, 150));
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
    if (t === "run.status" || t === "run.ask" || t === "run.outbound" || t === "run.archived") pushRun(runId);
    if (t === "run.event") {
      const run = opts.runs.get(runId);
      if (run && (TERMINAL_STATUSES as readonly string[]).includes(String(run.status ?? ""))) {
        schedulePush(runId);
      }
    }
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

  const onCommand = createRelayCommandHandler({ hubFetch, snapOf, send });

  const connect = () => {
    if (stopped) return;
    const next = new WebSocket(hubWsUrl(cfg));
    ws = next;
    next.addEventListener("open", () => {
      backoff = 1000;
      pushWorkspaces();
      dumpRuns();
      heartbeat?.();
      heartbeat = startRelayHeartbeat(next);
    });
    next.addEventListener("message", (e) => {
      let msg: any;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      void onCommand(msg);
    });
    const retry = () => {
      heartbeat?.(); heartbeat = null;
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
      for (const t of pushSoon.values()) clearTimeout(t);
      pushSoon.clear();
      heartbeat?.();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
