import { Hono } from "hono";
import { openDb } from "./db";
import { loadToken, authMiddleware, ARMADA_HOME } from "./auth";
import { Registry } from "./registry";
import { RunService } from "./runs";
import { handleWsMessage, type WsData } from "./ws";

export interface HubServer {
  server: ReturnType<typeof Bun.serve>;
  db: ReturnType<typeof openDb>;
  registry: Registry;
  runs: RunService;
  token: string;
  port: number;
  stop: () => void;
}

export function createServer(opts: { port?: number; hostname?: string; home?: string } = {}): HubServer {
  const home = ARMADA_HOME(opts.home);
  const token = loadToken(home);
  const db = openDb(home);
  const registry = new Registry(db);
  const runs = new RunService(db, registry);

  registry.inboundHandler = (ws, msg) => {
    const machineId = ws.data.machineId!;
    switch (msg.type) {
      case "run.ack": runs.onRunAck(machineId, msg); break;
      case "run.bound": runs.onRunBound(machineId, msg); break;
    }
  };

  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true, name: "armada-hub" }));
  app.use("/api/*", authMiddleware(token));
  app.get("/api/machines", (c) => c.json(registry.listMachines()));

  app.post("/api/runs", async (c) => {
    const body = await c.req.json();
    const { run, error } = runs.create(body.machineId, body.workspaceRoot, body.prompt);
    if (error) return c.json({ error }, error === "RUN_BUSY" ? 409 : 400);
    return c.json({ run }, 201);
  });
  app.get("/api/runs", (c) => c.json(runs.list(c.req.query("status"), c.req.query("machineId"))));
  app.get("/api/runs/:id", (c) => {
    const r = runs.get(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "NOT_FOUND" }, 404);
  });
  app.post("/api/runs/:id/cancel", (c) => {
    const { error } = runs.onCancelRequested(c.req.param("id"));
    if (error) return c.json({ error }, error === "NOT_FOUND" ? 404 : 409);
    return c.json({ ok: true });
  });

  const server = Bun.serve<WsData>({
    port: opts.port ?? 7380,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (url.searchParams.get("token") !== token) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        if (server.upgrade(req, { data: { registered: false } })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) { registry.onOpen(ws as any); },
      message(ws, data) { handleWsMessage(registry, ws as any, String(data)); },
      close(ws) { registry.onClose(ws as any); },
    },
  });

  const sweepTimer = setInterval(() => {
    registry.sweep();
    runs.sweepTimeouts();
  }, 15_000);
  return {
    server, db, registry, runs, token,
    port: server.port!,
    stop() { clearInterval(sweepTimer); server.stop(true); db.close(); },
  };
}

if (import.meta.main) {
  const lan = process.argv.includes("--lan");
  const s = createServer({ hostname: lan ? "0.0.0.0" : "127.0.0.1" });
  console.log(`armada-hub listening on http://${s.server.hostname}:${s.port} (token in ${ARMADA_HOME()}/token)`);
}
