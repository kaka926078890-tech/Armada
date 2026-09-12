import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRelayServer, type RelayServer } from "../src/server";
import { encodeWorkspaceId } from "../src/uri";

let srv: RelayServer | null = null;
afterEach(() => { srv?.stop(); srv = null; });

function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-relay-"));
  srv = createRelayServer({
    port: 0,
    hostname: "127.0.0.1",
    home,
    publicBase: "http://127.0.0.1:8780",
    adminToken: "adm-test",
  });
  return srv;
}

function url(s: RelayServer, p: string) {
  return `http://127.0.0.1:${s.port}${p}`;
}

function connectHub(s: RelayServer, fleet: string, secret: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/hub?fleet=${encodeURIComponent(fleet)}&secret=${encodeURIComponent(secret)}`);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error("hub ws failed"));
  });
}

function autoHub(ws: WebSocket, onDispatch?: (msg: any) => object | void) {
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === "cmd.dispatch") {
      const custom = onDispatch?.(msg);
      if (custom) { ws.send(JSON.stringify(custom)); return; }
      const decoded = String(msg.workspaceId).split("|");
      ws.send(JSON.stringify({
        type: "cmd.result",
        requestId: msg.requestId,
        ok: true,
        run: {
          runId: "r-1",
          machineId: decoded[0],
          workspaceRoot: decoded.slice(1).join("|"),
          prompt: msg.prompt,
          status: "dispatched",
          updatedAt: Date.now(),
        },
      }));
    }
    if (msg.type === "cmd.answer" || msg.type === "cmd.cancel") {
      ws.send(JSON.stringify({ type: "cmd.result", requestId: msg.requestId, ok: true }));
    }
  });
}

describe("relay serve", () => {
  test("health is unauthenticated", async () => {
    const s = start();
    const r = await fetch(url(s, "/health"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, name: "armada-relay" });
  });

  test("mobile without token is 401", async () => {
    const s = start();
    expect((await fetch(url(s, "/mobile/workspaces"))).status).toBe(401);
  });

  test("pair secret on mobile is 403 OPERATOR_REQUIRED", async () => {
    const s = start();
    const fleet = s.createFleet();
    const r = await fetch(url(s, "/mobile/workspaces"), {
      headers: { authorization: `Bearer ${fleet.hubSecret}` },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "OPERATOR_REQUIRED" });
  });

  test("op token on hub ws is 403 HUB_REQUIRED", async () => {
    const s = start();
    const fleet = s.createFleet();
    const r = await fetch(url(s, `/hub?fleet=${fleet.fleet}&secret=${fleet.operatorToken}`));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "HUB_REQUIRED" });
  });

  test("hub offline: empty workspaces and dispatch 503", async () => {
    const s = start();
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    const list = await (await fetch(url(s, "/mobile/workspaces"), { headers })).json() as any;
    expect(list.hubOffline).toBe(true);
    expect(list.workspaces).toEqual([]);
    const d = await fetch(url(s, "/mobile/runs"), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "m-1|/ws/a", prompt: "hi" }),
    });
    expect(d.status).toBe(503);
    expect(await d.json()).toEqual({ error: "HUB_OFFLINE" });
  });

  test("completed without finalText becomes NO_ASSISTANT_BODY", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-empty",
        machineId: "m-1",
        workspaceRoot: "/ws/a",
        prompt: "hi",
        status: "completed",
        finalText: "",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(50);
    const got = await (await fetch(url(s, "/mobile/runs/r-empty"), {
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
    })).json() as any;
    expect(got.status).toBe("error");
    expect(got.error).toBe("NO_ASSISTANT_BODY");
    expect(got.finalText).toBeNull();
    ws.close();
  });

  test("dispatch roundtrip with fake hub", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    autoHub(ws);
    ws.send(JSON.stringify({
      type: "snap.workspaces",
      machines: [{ id: "m-1", open_workspaces: JSON.stringify(["/Users/me/proj"]) }],
    }));
    await Bun.sleep(50);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const list = await (await fetch(url(s, "/mobile/workspaces"), { headers })).json() as any;
    expect(list.hubOffline).toBe(false);
    expect(list.workspaces[0]).toMatchObject({
      workspaceId: encodeWorkspaceId("m-1", "/Users/me/proj"),
      label: "proj",
    });
    const d = await fetch(url(s, "/mobile/runs"), {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: encodeWorkspaceId("m-1", "/Users/me/proj"), prompt: "hello fleet" }),
    });
    expect(d.status).toBe(201);
    const body = await d.json() as any;
    expect(body.run.runId).toBe("r-1");
    expect(body.run.prompt).toBe("hello fleet");
    expect(body.run.status).toBe("dispatched");
    ws.close();
  });

  test("admin fleets requires token", async () => {
    const s = start();
    expect((await fetch(url(s, "/admin/fleets"), { method: "POST" })).status).toBe(401);
    const ok = await fetch(url(s, "/admin/fleets"), {
      method: "POST",
      headers: { "x-relay-admin": "adm-test" },
    });
    expect(ok.status).toBe(201);
    const j = await ok.json() as any;
    expect(j.pairUri).toContain("armada-relay://pair");
    expect(j.opUri).toContain("armada-relay://op");
  });
});
