import { join } from "path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { openDb } from "./db";
import { loadToken, authMiddleware, ARMADA_HOME } from "./auth";
import { Registry } from "./registry";
import { RunService } from "./runs";
import { SseHub } from "./sse";
import { ingestEvent } from "./ingest";
import { handleWsMessage, type WsData } from "./ws";
import { limitsFromEnv, httpStatusForRunError, type ConcurrencyLimits } from "./concurrency";
import { BlobStore } from "./blobs";
import { readUiPrefs, writeUiPrefs, mergeUiPrefs } from "./uiPrefs";

export interface HubServer {
  server: ReturnType<typeof Bun.serve>;
  db: ReturnType<typeof openDb>;
  registry: Registry;
  runs: RunService;
  token: string;
  port: number;
  stop: () => void;
}

export function createServer(opts: { port?: number; hostname?: string; home?: string; concurrency?: ConcurrencyLimits } = {}): HubServer {
  const home = ARMADA_HOME(opts.home);
  const token = loadToken(home);
  const db = openDb(home);
  const registry = new Registry(db);
  const sse = new SseHub();
  const limits = opts.concurrency ?? limitsFromEnv();
  const blobs = new BlobStore(db, home);
  const runs = new RunService(db, registry, sse, { limits, blobs });
  registry.onMachinesChanged = () => sse.broadcast("*", { type: "machine.updated" });

  registry.inboundHandler = (ws, msg) => {
    const machineId = ws.data.machineId!;
    switch (msg.type) {
      case "run.ack": runs.onRunAck(machineId, msg); break;
      case "run.bound": runs.onRunBound(machineId, msg); break;
      case "run.event": {
        ingestEvent(db, runs, sse, machineId, msg);
        const ack = (msg as any).__ack;
        if (ack) registry.sendTo(machineId, ws.data.windowId!, ack);
        break;
      }
      case "run.note": {
        db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'extension','run.note',?2,?3)")
          .run(Date.now(), msg.runId, JSON.stringify({ level: msg.level, message: msg.message }));
        if (msg.message === "BIND_AMBIGUOUS") runs.onBindAmbiguous(msg.runId);
        break;
      }
      case "hooks.status": {
        db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'extension','hooks.status',?2,?3)")
          .run(Date.now(), machineId, JSON.stringify(msg));
        break;
      }
    }
  };

  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true, name: "armada-hub" }));
  app.use("/api/*", authMiddleware(token));
  app.get("/api/machines", (c) => c.json(registry.listMachines()));
  app.patch("/api/machines/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.displayName !== "string") return c.json({ error: "INVALID" }, 400);
    const { machine, error } = registry.setDisplayName(c.req.param("id"), body.displayName);
    if (error) return c.json({ error }, 404);
    return c.json({ machine });
  });

  app.post("/api/blobs", async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) return c.json({ error: "INVALID" }, 400);
    const bytes = Buffer.from(await file.arrayBuffer());
    const { blob, error, status } = blobs.put(bytes, file.type || "", file.name || "");
    if (error) return c.json({ error }, (status as 400 | 413 | 429) ?? 400);
    return c.json({ blob }, 201);
  });
  app.get("/api/blobs/:id", (c) => {
    const hit = blobs.get(c.req.param("id"));
    if (!hit) return c.json({ error: "ATTACHMENT_NOT_FOUND" }, 404);
    return new Response(hit.bytes, {
      headers: { "content-type": hit.mime, "cache-control": "private, max-age=3600" },
    });
  });

  app.post("/api/runs", async (c) => {
    const body = await c.req.json();
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((x: unknown) => typeof x === "string") : [];
    const { run, error, queuePosition } = runs.create(body.machineId, body.workspaceRoot, body.prompt ?? "", { attachmentIds });
    if (error) return c.json({ error }, httpStatusForRunError(error));
    return c.json({ run, queuePosition }, 201);
  });
  app.get("/api/runs", (c) => c.json(runs.list(c.req.query("status"), c.req.query("machineId"), c.req.query("archived"))));
  app.get("/api/runs/:id", (c) => {
    const r = runs.get(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "NOT_FOUND" }, 404);
  });
  app.post("/api/runs/:id/cancel", (c) => {
    const { error } = runs.onCancelRequested(c.req.param("id"));
    if (error) return c.json({ error }, error === "NOT_FOUND" ? 404 : 409);
    return c.json({ ok: true });
  });

  app.get("/api/runs/:id/events", (c) => {
    const afterSeq = Number(c.req.query("afterSeq") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 500), 2000);
    const rows = db.query("SELECT * FROM run_events WHERE run_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3")
      .all(c.req.param("id"), afterSeq, limit);
    return c.json(rows);
  });
  app.get("/api/runs/:id/stream", (c) => {
    const runId = c.req.param("id");
    const stream = new ReadableStream({
      start(controller) {
        // Flush headers immediately so clients are not blocked waiting for first event.
        controller.enqueue(new TextEncoder().encode(":ok\n\n"));
        const unregister = sse.register(runId, controller);
        (c.req.raw as any).signal?.addEventListener("abort", () => { unregister(); try { controller.close(); } catch {} });
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  });
  app.get("/api/events", (c) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(":ok\n\n"));
        const unregister = sse.register("*", controller);
        (c.req.raw as any).signal?.addEventListener("abort", () => { unregister(); try { controller.close(); } catch {} });
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  });
  app.get("/api/audit/export", (c) => {
    const from = Number(c.req.query("from") ?? 0);
    const to = Number(c.req.query("to") ?? Date.now());
    const rows = db.query("SELECT * FROM audit WHERE ts BETWEEN ?1 AND ?2 ORDER BY id").all(from, to) as any[];
    return new Response(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
      headers: { "content-type": "application/x-ndjson", "content-disposition": "attachment; filename=armada-audit.jsonl" },
    });
  });

  app.get("/api/ui-prefs", (c) => {
    const r = readUiPrefs(home);
    if (!r.ok) {
      db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'hub','UI_PREFS_READ_FAIL',?2,?3)")
        .run(Date.now(), home, JSON.stringify({ error: r.error }));
      return c.json({ error: "READ_FAIL" }, 503);
    }
    return c.json({ ...r.prefs, source: r.source });
  });
  app.put("/api/ui-prefs", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "INVALID" }, 400);
    const cur = readUiPrefs(home);
    if (!cur.ok) {
      db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'hub','UI_PREFS_READ_FAIL',?2,?3)")
        .run(Date.now(), home, JSON.stringify({ error: cur.error }));
      return c.json({ error: "READ_FAIL" }, 503);
    }
    try {
      const next = mergeUiPrefs(cur.prefs, body as Record<string, unknown>);
      writeUiPrefs(home, next);
      return c.json(next);
    } catch {
      db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'hub','UI_PREFS_WRITE_FAIL',?2,?3)")
        .run(Date.now(), home, "{}");
      return c.json({ error: "WRITE_FAIL" }, 500);
    }
  });

  app.post("/api/runs/:id/followup", async (c) => {
    const parent = runs.get(c.req.param("id"));
    if (!parent) return c.json({ error: "NOT_FOUND" }, 404);
    if (!parent.conversation_id) return c.json({ error: "NO_CONVERSATION" }, 409);
    if (parent.end_reason === "OPERATOR_CLOSED") {
      return c.json({ error: "CLOSED" }, 400);
    }
    const { prompt, attachmentIds: rawIds } = await c.req.json();
    const attachmentIds = Array.isArray(rawIds) ? rawIds.filter((x: unknown) => typeof x === "string") : [];
    const { run, error } = runs.followup(parent.id, typeof prompt === "string" ? prompt : "", attachmentIds);
    if (error) return c.json({ error }, httpStatusForRunError(error));
    return c.json({ run }, 200);
  });
  app.post("/api/runs/:id/close", (c) => {
    const { error } = runs.close(c.req.param("id"));
    if (error) return c.json({ error }, error === "NOT_FOUND" ? 404 : 409);
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/archive", (c) => {
    const { error, run } = runs.archive(c.req.param("id"));
    if (error) return c.json({ error }, error === "NOT_FOUND" ? 404 : 409);
    return c.json({ run });
  });
  app.post("/api/runs/:id/unarchive", (c) => {
    const { error, run } = runs.unarchive(c.req.param("id"));
    if (error) return c.json({ error }, error === "NOT_FOUND" ? 404 : 409);
    return c.json({ run });
  });

  const webRoot = join(import.meta.dir, "../web/dist");
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: join(webRoot, "index.html") }));

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

  blobs.sweep();
  const sweepTimer = setInterval(() => {
    registry.sweep();
    runs.sweepTimeouts();
    blobs.sweep();
  }, 15_000);
  return {
    server, db, registry, runs, token,
    port: server.port!,
    stop() { clearInterval(sweepTimer); sse.closeAll(); server.stop(true); db.close(); },
  };
}

if (import.meta.main) {
  const lan = process.argv.includes("--lan");
  const limits = limitsFromEnv();
  const s = createServer({ hostname: lan ? "0.0.0.0" : "127.0.0.1", concurrency: limits });
  console.log(`armada-hub listening on http://${s.server.hostname}:${s.port} (token in ${ARMADA_HOME()}/token)`);
  console.log(`armada-hub concurrency=v2-slot N=${limits.maxPerMachine} M=${limits.maxPerWorkspace} multiWindow=${limits.multiRunPerWindow ? 1 : 0}`);
}
