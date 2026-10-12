import { desktopTokenColumnReady } from "./db";
import {
  DESK_IDLE_MS,
  DESK_RATE_MAX,
  DESK_RATE_WINDOW_MS,
  DESK_WS_MAX,
  byteAssembler,
  byteFrames,
  decodeBody,
  forwardRequestHeaders,
  routeDesktop,
  textAssembler,
  textFrames,
  type PartAssembler,
} from "./desktopFrames";

type FleetRow = { id: string; hub_online: number };

type HttpResult =
  | { error: "HUB_TIMEOUT" }
  | { status: number; headers: Record<string, string>; body: Uint8Array };

type HttpWait = {
  asm: PartAssembler<Uint8Array>;
  timer: ReturnType<typeof setTimeout>;
  status: number;
  headers: Record<string, string>;
  resolve: (v: HttpResult) => void;
};

type SseWait = {
  next: number;
  pending: Map<number, string>;
  write: (s: string) => void;
  close: () => void;
};

type DeskSocket = {
  data: { fleetId?: string; streamId?: string };
  send: (s: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type DesktopHandle =
  | Response
  | Promise<Response>
  | { upgrade: { fleetId: string; streamId: string } };

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1]!.trim() : null;
}

function responseHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const key = k.toLowerCase();
    if (key === "content-type" || key === "cache-control" || key === "content-disposition") out[key] = v;
  }
  return out;
}

export function createDesktopGateway(deps: {
  protocolVersion: number;
  idleMs?: number;
  getFleetByDesktop: (token: string) => FleetRow | undefined;
  getFleetByOp: (token: string) => FleetRow | undefined;
  getFleetBySecret: (token: string) => FleetRow | undefined;
  sendHub: (fleetId: string, msg: object) => boolean;
  audit: (actor: string, action: string, target?: string, payload?: object) => void;
}) {
  const idleMs = deps.idleMs ?? DESK_IDLE_MS;
  const rate = new Map<string, number[]>();
  const wsCount = new Map<string, number>();
  const sockets = new Map<string, DeskSocket>();
  const textIn = new Map<string, PartAssembler<string>>();
  const httpWaits = new Map<string, HttpWait>();
  const sseWaits = new Map<string, SseWait>();
  let seq = 0;

  function checkRate(token: string): boolean {
    const now = Date.now();
    const arr = (rate.get(token) ?? []).filter((t) => now - t < DESK_RATE_WINDOW_MS);
    if (arr.length >= DESK_RATE_MAX) {
      rate.set(token, arr);
      return false;
    }
    arr.push(now);
    rate.set(token, arr);
    return true;
  }

  function denied(status: 401 | 403, error: string, fleetId?: string): Response {
    deps.audit("desktop", "join.denied", fleetId, { status });
    return Response.json({ error }, { status });
  }

  function fail(status: number, error: string): Response {
    return Response.json({ error }, { status });
  }

  function armHttp(streamId: string, resolve: (v: HttpResult) => void): HttpWait {
    const wait: HttpWait = {
      asm: byteAssembler(),
      timer: setTimeout(() => {
        httpWaits.delete(streamId);
        resolve({ error: "HUB_TIMEOUT" });
      }, idleMs),
      status: 200,
      headers: {},
      resolve,
    };
    httpWaits.set(streamId, wait);
    return wait;
  }

  function touch(streamId: string, wait: HttpWait) {
    clearTimeout(wait.timer);
    wait.timer = setTimeout(() => {
      if (httpWaits.get(streamId) !== wait) return;
      httpWaits.delete(streamId);
      wait.resolve({ error: "HUB_TIMEOUT" });
    }, idleMs);
  }

  async function proxyHttp(fleetId: string, req: Request, upstream: string, stream: boolean): Promise<Response> {
    const streamId = `h${++seq}`;
    if (stream) {
      if (!deps.sendHub(fleetId, { type: "desk.stream.open", streamId, path: upstream })) return fail(503, "HUB_OFFLINE");
      const body = new ReadableStream({
        start(controller) {
          sseWaits.set(streamId, {
            next: 0,
            pending: new Map(),
            write: (s) => controller.enqueue(new TextEncoder().encode(s)),
            close: () => { try { controller.close(); } catch { /* already closed */ } },
          });
        },
        cancel() {
          sseWaits.delete(streamId);
          deps.sendHub(fleetId, { type: "desk.stream.end", streamId });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    const raw = req.method === "GET" || req.method === "HEAD" ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());
    const headers = forwardRequestHeaders(req.headers);
    let result!: HttpResult;
    let settled = false;
    const done = new Promise<HttpResult>((resolve) => {
      armHttp(streamId, (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      });
    });
    for (const frame of byteFrames(raw)) {
      const sent = deps.sendHub(fleetId, {
        type: "desk.http",
        streamId,
        method: req.method,
        path: upstream,
        headers,
        ...frame,
      });
      if (!sent) {
        const wait = httpWaits.get(streamId);
        if (wait) clearTimeout(wait.timer);
        httpWaits.delete(streamId);
        return fail(503, "HUB_OFFLINE");
      }
    }
    result = await done;
    if ("error" in result) return fail(502, "HUB_TIMEOUT");
    return new Response(result.body, { status: result.status, headers: result.headers });
  }

  function handle(req: Request): DesktopHandle {
    const url = new URL(req.url);
    const route = routeDesktop(url.pathname, url.search);
    if (route.kind === "health") {
      return Response.json({ ok: true, name: "armada-relay", protocolVersion: deps.protocolVersion });
    }
    if (route.kind === "miss") return fail(404, "NOT_FOUND");
    if (!desktopTokenColumnReady()) return fail(503, "DESKTOP_UNAVAILABLE");
    const token = bearer(req);
    if (!token) return denied(401, "unauthorized");
    if (deps.getFleetByOp(token) || deps.getFleetBySecret(token)) return denied(403, "DESKTOP_REQUIRED");
    const fleet = deps.getFleetByDesktop(token);
    if (!fleet) return denied(401, "unauthorized");
    const headerFleet = req.headers.get("x-armada-fleet")?.trim() ?? "";
    if (headerFleet !== fleet.id) return denied(403, "FLEET_MISMATCH", fleet.id);
    if (fleet.hub_online !== 1) return fail(503, "HUB_OFFLINE");
    if (!checkRate(token)) return fail(429, "RATE_LIMIT");
    if (route.kind === "ws") {
      if ((wsCount.get(fleet.id) ?? 0) >= DESK_WS_MAX) return fail(429, "RATE_LIMIT");
      return { upgrade: { fleetId: fleet.id, streamId: `w${++seq}` } };
    }
    return proxyHttp(fleet.id, req, route.upstream, route.stream);
  }

  function onDesktopOpen(ws: DeskSocket) {
    const fleetId = ws.data.fleetId ?? "";
    const streamId = ws.data.streamId ?? "";
    wsCount.set(fleetId, (wsCount.get(fleetId) ?? 0) + 1);
    sockets.set(streamId, ws);
    deps.audit("desktop", "join.open", fleetId, { status: 101 });
    if (!deps.sendHub(fleetId, { type: "desk.ws.open", streamId })) ws.close(1011, "offline");
  }

  function onDesktopMessage(ws: DeskSocket, data: string | Buffer) {
    const streamId = ws.data.streamId ?? "";
    const fleetId = ws.data.fleetId ?? "";
    if (typeof data !== "string") {
      ws.close(1003, "binary");
      return;
    }
    for (const frame of textFrames(data)) {
      deps.sendHub(fleetId, { type: "desk.ws.frame", streamId, ...frame });
    }
  }

  function onDesktopClose(ws: DeskSocket) {
    const fleetId = ws.data.fleetId ?? "";
    const streamId = ws.data.streamId ?? "";
    wsCount.set(fleetId, Math.max(0, (wsCount.get(fleetId) ?? 1) - 1));
    if (!sockets.has(streamId)) return;
    sockets.delete(streamId);
    textIn.delete(streamId);
    deps.sendHub(fleetId, { type: "desk.ws.close", streamId, code: 1000, reason: "" });
  }

  function onHubFrame(msg: any) {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("desk.")) return;
    const streamId = typeof msg.streamId === "string" ? msg.streamId : "";
    if (msg.type === "desk.http.result") {
      const wait = httpWaits.get(streamId);
      if (!wait) return;
      touch(streamId, wait);
      if (typeof msg.status === "number") wait.status = msg.status;
      const headers = responseHeaders(msg.headers);
      if (Object.keys(headers).length) wait.headers = headers;
      const pushed = wait.asm.push(Number(msg.seq), msg.last === true, decodeBody(typeof msg.bodyBase64 === "string" ? msg.bodyBase64 : undefined));
      if (!pushed.ok) {
        clearTimeout(wait.timer);
        httpWaits.delete(streamId);
        wait.resolve({ error: "HUB_TIMEOUT" });
        return;
      }
      if (pushed.done) {
        clearTimeout(wait.timer);
        httpWaits.delete(streamId);
        wait.resolve({ status: wait.status, headers: wait.headers, body: pushed.value });
      }
      return;
    }
    if (msg.type === "desk.stream.chunk") {
      const sse = sseWaits.get(streamId);
      if (!sse || typeof msg.seq !== "number" || typeof msg.data !== "string") return;
      sse.pending.set(msg.seq, msg.data);
      while (sse.pending.has(sse.next)) {
        sse.write(sse.pending.get(sse.next) ?? "");
        sse.pending.delete(sse.next);
        sse.next++;
      }
      return;
    }
    if (msg.type === "desk.stream.end") {
      const sse = sseWaits.get(streamId);
      if (!sse) return;
      sseWaits.delete(streamId);
      sse.close();
      return;
    }
    if (msg.type === "desk.ws.frame") {
      const sock = sockets.get(streamId);
      if (!sock || typeof msg.data !== "string" || typeof msg.seq !== "number") return;
      let asm = textIn.get(streamId);
      if (!asm) {
        asm = textAssembler();
        textIn.set(streamId, asm);
      }
      const pushed = asm.push(msg.seq, msg.last === true, msg.data);
      if (!pushed.ok) {
        sock.close(1003, "frame");
        return;
      }
      if (pushed.done) {
        textIn.delete(streamId);
        sock.send(pushed.value);
      }
      return;
    }
    if (msg.type === "desk.ws.close") {
      const sock = sockets.get(streamId);
      if (!sock) return;
      sockets.delete(streamId);
      textIn.delete(streamId);
      const code = typeof msg.code === "number" ? msg.code : 1000;
      const reason = typeof msg.reason === "string" ? msg.reason : "";
      sock.close(code, reason);
    }
  }

  return { handle, onDesktopOpen, onDesktopMessage, onDesktopClose, onHubFrame };
}
