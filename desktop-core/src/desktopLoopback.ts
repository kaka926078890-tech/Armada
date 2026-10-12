import {
  desktopPlaceholderOk,
  relayDesktopHttp,
  relayDesktopWs,
  shouldPersistDesktopJoin,
} from "./desktopRelay";

export type DesktopLoopbackOpts = {
  relay: string;
  fleet: string;
  desktopToken: string;
  placeholder: string;
  port?: number;
  fetchImpl?: typeof fetch;
};

function relayHeaders(req: Request, fleet: string, desktopToken: string): Headers {
  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  const accept = req.headers.get("accept");
  if (contentType) headers.set("content-type", contentType);
  if (accept) headers.set("accept", accept);
  headers.set("authorization", `Bearer ${desktopToken}`);
  headers.set("x-armada-fleet", fleet);
  return headers;
}

export function startDesktopLoopback(opts: DesktopLoopbackOpts): { port: number; stop: () => void } {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const upstreamWs = relayDesktopWs(opts.relay);
  const server = Bun.serve<{ upstream?: WebSocket }>({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (!desktopPlaceholderOk(url.search, req.headers.get("authorization"), opts.placeholder)) {
        return new Response("unauthorized", { status: 401 });
      }
      if (url.pathname === "/ws") {
        const upstream = new WebSocket(upstreamWs, {
          headers: {
            authorization: `Bearer ${opts.desktopToken}`,
            "x-armada-fleet": opts.fleet,
          },
        } as any);
        if (srv.upgrade(req, { data: { upstream } })) return;
        upstream.close();
        return new Response("upgrade failed", { status: 400 });
      }
      const target = relayDesktopHttp(opts.relay, url.pathname, url.search);
      const headers = relayHeaders(req, opts.fleet, opts.desktopToken);
      if (req.method === "GET" || req.method === "HEAD") return fetchImpl(target, { method: req.method, headers });
      return req.arrayBuffer().then((body) => fetchImpl(target, { method: req.method, headers, body }));
    },
    websocket: {
      open(ws) {
        const upstream = ws.data.upstream;
        if (!upstream) return;
        upstream.addEventListener("message", (ev) => {
          if (typeof ev.data !== "string") {
            ws.close(1003, "binary");
            return;
          }
          ws.send(ev.data);
        });
        upstream.addEventListener("close", (ev) => {
          try { ws.close(ev.code, ev.reason); } catch { /* already closed */ }
        });
      },
      message(ws, data) {
        const upstream = ws.data.upstream;
        if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
        if (typeof data !== "string") {
          ws.close(1003, "binary");
          return;
        }
        upstream.send(data);
      },
      close(ws) {
        try { ws.data.upstream?.close(); } catch { /* already closed */ }
      },
    },
  });
  return {
    port: server.port!,
    stop() { server.stop(true); },
  };
}

async function probe(relay: string, fleet: string, desktopToken: string): Promise<number> {
  const res = await fetch(`${relay.replace(/\/+$/, "")}/desktop/api/machines`, {
    headers: { authorization: `Bearer ${desktopToken}`, "x-armada-fleet": fleet },
  });
  return res.status;
}

if (import.meta.main) {
  const relay = process.env.ARMADA_DESKTOP_RELAY ?? "";
  const fleet = process.env.ARMADA_DESKTOP_FLEET ?? "";
  const desktopToken = process.env.ARMADA_DESKTOP_TOKEN ?? "";
  const placeholder = process.env.ARMADA_DESKTOP_PLACEHOLDER ?? "";
  const port = Number(process.env.ARMADA_DESKTOP_PORT ?? "0");
  const status = await probe(relay, fleet, desktopToken).catch(() => 0);
  if (!shouldPersistDesktopJoin(status)) {
    const error = status === 403 ? "FLEET_MISMATCH" : status === 503 ? "HUB_OFFLINE" : "unauthorized";
    console.log(JSON.stringify({ error }));
    process.exit(1);
  }
  const loop = startDesktopLoopback({ relay, fleet, desktopToken, placeholder, port });
  console.log(JSON.stringify({ port: loop.port }));
}
