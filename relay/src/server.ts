import { randomBytes } from "crypto";
import { join } from "path";
import { mkdirSync } from "fs";
import { Hono } from "hono";
import { openRelayDb } from "./db";
import { decodeWorkspaceId, encodeWorkspaceId, formatOpUri, formatPairUri } from "./uri";

export const PROTOCOL_VERSION = 1;
const MAX_BODY = 20 * 1024 * 1024;
const DISPATCH_TIMEOUT_MS = 15_000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 20;

export type WorkspaceSnap = {
  machineId: string;
  workspaceRoot: string;
  label?: string;
};

export type RunSnap = {
  runId: string;
  machineId: string;
  workspaceRoot: string;
  prompt: string;
  status: string;
  finalText?: string | null;
  error?: string | null;
  pendingAsk?: unknown;
  updatedAt?: number;
};

type Pending = { resolve: (v: { ok: boolean; error?: string; run?: RunSnap }) => void };

function hex64(): string {
  return randomBytes(32).toString("hex");
}

function fleetId(): string {
  return `fleet-${randomBytes(6).toString("hex")}`;
}

function labelOf(root: string): string {
  const parts = root.replace(/\/+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || root;
}

function bearer(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1].trim() : null;
}

export interface RelayServer {
  port: number;
  publicBase: string;
  adminToken: string;
  stop: () => void;
  createFleet: () => { fleet: string; pairUri: string; opUri: string; hubSecret: string; operatorToken: string };
}

export function createRelayServer(opts: {
  port?: number;
  hostname?: string;
  home?: string;
  publicBase: string;
  adminToken?: string;
}): RelayServer {
  const home = opts.home ?? join(process.env.HOME!, ".armada-relay");
  mkdirSync(home, { recursive: true });
  const db = openRelayDb(home);
  const adminToken = opts.adminToken ?? hex64();
  const publicBase = opts.publicBase.replace(/\/+$/, "");
  const pending = new Map<string, Pending>();
  const hubSockets = new Map<string, { send: (s: string) => void }>();
  const rate = new Map<string, number[]>();
  let reqSeq = 0;

  function audit(actor: string, action: string, target?: string, payload?: object) {
    db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,?2,?3,?4,?5)")
      .run(Date.now(), actor, action, target ?? null, payload ? JSON.stringify(payload) : null);
  }

  function getFleetByOp(token: string) {
    return db.query("SELECT * FROM fleets WHERE operator_token=?1").get(token) as
      | { id: string; hub_secret: string; operator_token: string; hub_online: number; workspaces: string }
      | undefined;
  }
  function getFleetBySecret(secret: string) {
    return db.query("SELECT * FROM fleets WHERE hub_secret=?1").get(secret) as
      | { id: string; hub_secret: string; operator_token: string; hub_online: number; workspaces: string }
      | undefined;
  }
  function getFleet(id: string) {
    return db.query("SELECT * FROM fleets WHERE id=?1").get(id) as
      | { id: string; hub_secret: string; operator_token: string; hub_online: number; workspaces: string }
      | undefined;
  }

  function createFleet() {
    const id = fleetId();
    const hubSecret = hex64();
    const operatorToken = hex64();
    db.query("INSERT INTO fleets (id, hub_secret, operator_token, hub_online, workspaces, created_at) VALUES (?1,?2,?3,0,'[]',?4)")
      .run(id, hubSecret, operatorToken, Date.now());
    audit("admin", "fleet.create", id);
    return {
      fleet: id,
      hubSecret,
      operatorToken,
      pairUri: formatPairUri(publicBase, id, hubSecret),
      opUri: formatOpUri(publicBase, id, operatorToken),
    };
  }

  function applyRunSnap(fleetId: string, snap: RunSnap) {
    let status = snap.status;
    let finalText = snap.finalText ?? null;
    let error = snap.error ?? null;
    if (status === "completed" && !(finalText && finalText.length > 0)) {
      status = "error";
      error = "NO_ASSISTANT_BODY";
      finalText = null;
    }
    const now = snap.updatedAt ?? Date.now();
    const pendingAsk = snap.pendingAsk == null ? null : JSON.stringify(snap.pendingAsk);
    const existing = db.query("SELECT id FROM runs WHERE id=?1").get(snap.runId) as { id: string } | undefined;
    if (existing) {
      db.query(`UPDATE runs SET fleet_id=?2, machine_id=?3, workspace_root=?4, prompt=?5, status=?6,
        final_text=?7, error=?8, pending_ask=?9, updated_at=?10 WHERE id=?1`)
        .run(snap.runId, fleetId, snap.machineId, snap.workspaceRoot, snap.prompt, status, finalText, error, pendingAsk, now);
    } else {
      db.query(`INSERT INTO runs (id, fleet_id, machine_id, workspace_root, prompt, status, final_text, error, pending_ask, updated_at, created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)`)
        .run(snap.runId, fleetId, snap.machineId, snap.workspaceRoot, snap.prompt, status, finalText, error, pendingAsk, now);
    }
    return db.query("SELECT * FROM runs WHERE id=?1").get(snap.runId);
  }

  function runToJson(row: any) {
    return {
      runId: row.id,
      machineId: row.machine_id,
      workspaceRoot: row.workspace_root,
      prompt: row.prompt,
      status: row.status,
      finalText: row.final_text,
      error: row.error,
      pendingAsk: row.pending_ask ? JSON.parse(row.pending_ask) : null,
      updatedAt: row.updated_at,
    };
  }

  function sendHub(fleetId: string, msg: object): boolean {
    const sock = hubSockets.get(fleetId);
    if (!sock) return false;
    sock.send(JSON.stringify(msg));
    return true;
  }

  function waitHub(requestId: string): Promise<{ ok: boolean; error?: string; run?: RunSnap }> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: "HUB_TIMEOUT" });
      }, DISPATCH_TIMEOUT_MS);
      pending.set(requestId, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
      });
    });
  }

  function checkRate(token: string): boolean {
    const now = Date.now();
    const arr = (rate.get(token) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX) { rate.set(token, arr); return false; }
    arr.push(now);
    rate.set(token, arr);
    return true;
  }

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, name: "armada-relay", protocolVersion: PROTOCOL_VERSION }));

  app.post("/admin/fleets", async (c) => {
    if (c.req.header("x-relay-admin") !== adminToken) return c.json({ error: "unauthorized" }, 401);
    return c.json(createFleet(), 201);
  });

  app.use("/mobile/*", async (c, next) => {
    const tok = bearer(c);
    if (!tok) return c.json({ error: "unauthorized" }, 401);
    const fleet = getFleetByOp(tok);
    if (!fleet) {
      if (getFleetBySecret(tok)) return c.json({ error: "OPERATOR_REQUIRED" }, 403);
      return c.json({ error: "unauthorized" }, 401);
    }
    (c as any).set("fleet", fleet);
    (c as any).set("opToken", tok);
    await next();
  });

  app.get("/mobile/workspaces", (c) => {
    const fleet = (c as any).get("fleet") as { id: string; hub_online: number; workspaces: string };
    const hubOffline = fleet.hub_online !== 1;
    const raw = hubOffline ? [] : JSON.parse(fleet.workspaces || "[]") as WorkspaceSnap[];
    const workspaces = raw.map((w) => ({
      workspaceId: encodeWorkspaceId(w.machineId, w.workspaceRoot),
      machineId: w.machineId,
      workspaceRoot: w.workspaceRoot,
      label: w.label || labelOf(w.workspaceRoot),
    }));
    return c.json({ hubOffline, workspaces });
  });

  app.post("/mobile/runs", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_BODY) return c.json({ error: "PAYLOAD_TOO_LARGE" }, 413);
    const tok = (c as any).get("opToken") as string;
    const fleet = (c as any).get("fleet") as { id: string; hub_online: number };
    if (!checkRate(tok)) {
      audit("operator", "run.rate_limit", fleet.id);
      return c.json({ error: "RATE_LIMIT" }, 429);
    }
    if (fleet.hub_online !== 1) return c.json({ error: "HUB_OFFLINE" }, 503);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.workspaceId !== "string" || typeof body.prompt !== "string") {
      return c.json({ error: "INVALID" }, 400);
    }
    const decoded = decodeWorkspaceId(body.workspaceId);
    if (!decoded) return c.json({ error: "INVALID" }, 400);
    const requestId = `r${++reqSeq}`;
    const sent = sendHub(fleet.id, {
      type: "cmd.dispatch",
      requestId,
      workspaceId: body.workspaceId,
      prompt: body.prompt,
    });
    if (!sent) return c.json({ error: "HUB_OFFLINE" }, 503);
    const result = await waitHub(requestId);
    if (!result.ok) {
      const err = result.error ?? "HUB_TIMEOUT";
      const status = err === "WORKSPACE_NOT_OPEN" || err === "MACHINE_OFFLINE" ? 400
        : err === "PROMPT_COLLISION" ? 409
        : err === "RUN_LIMIT" ? 429
        : err === "HUB_OFFLINE" ? 503
        : 502;
      return c.json({ error: err }, status as 400);
    }
    const run = result.run!;
    applyRunSnap(fleet.id, run);
    audit("operator", "run.dispatch", run.runId, { fleet: fleet.id });
    return c.json({ run: runToJson(db.query("SELECT * FROM runs WHERE id=?1").get(run.runId)) }, 201);
  });

  app.get("/mobile/runs", (c) => {
    const fleet = (c as any).get("fleet") as { id: string };
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 50);
    const rows = db.query("SELECT * FROM runs WHERE fleet_id=?1 ORDER BY updated_at DESC LIMIT ?2").all(fleet.id, limit);
    return c.json({ runs: rows.map(runToJson) });
  });

  app.get("/mobile/runs/:id", (c) => {
    const fleet = (c as any).get("fleet") as { id: string };
    const row = db.query("SELECT * FROM runs WHERE id=?1 AND fleet_id=?2").get(c.req.param("id"), fleet.id);
    if (!row) return c.json({ error: "NOT_FOUND" }, 404);
    return c.json(runToJson(row));
  });

  app.post("/mobile/runs/:id/answer", async (c) => {
    const fleet = (c as any).get("fleet") as { id: string; hub_online: number };
    if (fleet.hub_online !== 1) return c.json({ error: "HUB_OFFLINE" }, 503);
    const body = await c.req.json().catch(() => ({}));
    const requestId = `r${++reqSeq}`;
    const sent = sendHub(fleet.id, { type: "cmd.answer", requestId, runId: c.req.param("id"), body });
    if (!sent) return c.json({ error: "HUB_OFFLINE" }, 503);
    const result = await waitHub(requestId);
    if (!result.ok) return c.json({ error: result.error ?? "HUB_TIMEOUT" }, 409);
    if (result.run) applyRunSnap(fleet.id, result.run);
    return c.json({ ok: true }, 202);
  });

  app.post("/mobile/runs/:id/cancel", async (c) => {
    const fleet = (c as any).get("fleet") as { id: string; hub_online: number };
    if (fleet.hub_online !== 1) return c.json({ error: "HUB_OFFLINE" }, 503);
    const requestId = `r${++reqSeq}`;
    const sent = sendHub(fleet.id, { type: "cmd.cancel", requestId, runId: c.req.param("id") });
    if (!sent) return c.json({ error: "HUB_OFFLINE" }, 503);
    const result = await waitHub(requestId);
    if (!result.ok) return c.json({ error: result.error ?? "HUB_TIMEOUT" }, 409);
    if (result.run) applyRunSnap(fleet.id, result.run);
    return c.json({ ok: true });
  });

  const server = Bun.serve<{ fleetId?: string; role?: string }>({
    port: opts.port ?? 8780,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/hub") {
        const fleet = url.searchParams.get("fleet") ?? "";
        const secret = url.searchParams.get("secret") ?? "";
        const row = getFleet(fleet);
        if (!row || row.hub_secret !== secret) {
          if (getFleetByOp(secret)) return new Response(JSON.stringify({ error: "HUB_REQUIRED" }), { status: 403 });
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        if (srv.upgrade(req, { data: { fleetId: fleet, role: "hub" } })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const id = ws.data.fleetId!;
        hubSockets.set(id, { send: (s) => ws.send(s) });
        db.query("UPDATE fleets SET hub_online=1 WHERE id=?1").run(id);
      },
      message(ws, data) {
        const fleetId = ws.data.fleetId!;
        let msg: any;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.type === "snap.workspaces") {
          const machines = Array.isArray(msg.machines) ? msg.machines : [];
          const slots: WorkspaceSnap[] = [];
          for (const m of machines) {
            const roots = typeof m.open_workspaces === "string" ? JSON.parse(m.open_workspaces) : (m.openWorkspaces ?? m.open_workspaces ?? []);
            for (const root of roots) {
              if (typeof root === "string") slots.push({ machineId: m.id ?? m.machineId, workspaceRoot: root, label: labelOf(root) });
            }
          }
          db.query("UPDATE fleets SET workspaces=?1 WHERE id=?2").run(JSON.stringify(slots), fleetId);
        } else if (msg.type === "snap.run" && msg.run) {
          applyRunSnap(fleetId, msg.run);
        } else if (msg.type === "cmd.result" && msg.requestId) {
          const p = pending.get(msg.requestId);
          if (p) {
            pending.delete(msg.requestId);
            p.resolve({ ok: !!msg.ok, error: msg.error, run: msg.run });
          }
        }
      },
      close(ws) {
        const id = ws.data.fleetId;
        if (!id) return;
        hubSockets.delete(id);
        db.query("UPDATE fleets SET hub_online=0 WHERE id=?1").run(id);
      },
    },
  });

  return {
    port: server.port!,
    publicBase,
    adminToken,
    createFleet,
    stop() { server.stop(true); db.close(); },
  };
}
