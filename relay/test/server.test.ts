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
    if (msg.type === "cmd.followup") {
      ws.send(JSON.stringify({
        type: "cmd.result",
        requestId: msg.requestId,
        ok: true,
        run: {
          runId: msg.runId,
          machineId: "m-1",
          workspaceRoot: "/Users/me/proj",
          prompt: msg.prompt,
          status: "dispatched",
          updatedAt: Date.now(),
        },
      }));
    }
    if (msg.type === "cmd.retry") {
      ws.send(JSON.stringify({
        type: "cmd.result",
        requestId: msg.requestId,
        ok: true,
        run: {
          runId: msg.runId,
          machineId: "m-1",
          workspaceRoot: "/Users/me/proj",
          prompt: "retry",
          status: "dispatched",
          canRetry: false,
          updatedAt: Date.now(),
        },
      }));
    }
    if (msg.type === "cmd.archive" || msg.type === "cmd.unarchive") {
      ws.send(JSON.stringify({
        type: "cmd.result",
        requestId: msg.requestId,
        ok: true,
        run: {
          runId: msg.runId,
          machineId: "m-1",
          workspaceRoot: "/Users/me/proj",
          prompt: "hello fleet",
          status: "completed",
          finalText: "好了",
          archived: msg.type === "cmd.archive",
          updatedAt: Date.now(),
        },
      }));
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
      machines: [{ id: "m-1", name: "MacBook-Pro.local", display_name: "Mac Intel", os: "darwin-arm64", status: "online", open_workspaces: JSON.stringify(["/Users/me/proj"]) }],
    }));
    await Bun.sleep(50);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const list = await (await fetch(url(s, "/mobile/workspaces"), { headers })).json() as any;
    expect(list.hubOffline).toBe(false);
    expect(list.workspaces[0]).toMatchObject({
      workspaceId: encodeWorkspaceId("m-1", "/Users/me/proj"),
      label: "proj",
      machineName: "Mac Intel",
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

  test("snap.run outbound is returned on GET", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-1",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello fleet",
        status: "running",
        outbound: [{ id: "o1", prompt: "排队", expectedMode: "queue", state: "queued", createdAt: 1 }],
        queueMessageDefaultBehavior: "queue",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    const got = await (await fetch(url(s, "/mobile/runs/r-1"), { headers })).json() as any;
    expect(got.status).toBe("running");
    expect(got.outbound).toEqual([
      { id: "o1", prompt: "排队", expectedMode: "queue", state: "queued", createdAt: 1 },
    ]);
    expect(got.queueMessageDefaultBehavior).toBe("queue");
    ws.close();
  });

  test("followup reopens the same run", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    autoHub(ws);
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-1",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello fleet",
        status: "completed",
        finalText: "好了",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const f = await fetch(url(s, "/mobile/runs/r-1/followup"), {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "继续" }),
    });
    expect(f.status).toBe(200);
    const body = await f.json() as any;
    expect(body.run.runId).toBe("r-1");
    expect(body.run.prompt).toBe("继续");
    expect(body.run.status).toBe("dispatched");
    ws.close();
  });

  test("retry reopens the same error run", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    autoHub(ws);
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-err",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "失败句",
        status: "error",
        error: "REJECTED",
        canRetry: true,
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const got = await (await fetch(url(s, "/mobile/runs/r-err"), { headers })).json() as any;
    expect(got.canRetry).toBe(true);
    const f = await fetch(url(s, "/mobile/runs/r-err/retry"), { method: "POST", headers });
    expect(f.status).toBe(200);
    const body = await f.json() as any;
    expect(body.run.runId).toBe("r-err");
    expect(body.run.status).toBe("dispatched");
    ws.close();
  });

  test("archived snap is hidden from default list and listed with archived=1", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const visible = {
      runId: "r-1",
      machineId: "m-1",
      workspaceRoot: "/Users/me/proj",
      prompt: "hello fleet",
      status: "completed",
      finalText: "好了",
      archived: false,
      updatedAt: Date.now(),
    };
    ws.send(JSON.stringify({ type: "snap.run", run: visible }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    const open = await (await fetch(url(s, "/mobile/runs"), { headers })).json() as any;
    expect(open.runs.map((r: any) => r.runId)).toContain("r-1");
    expect(open.runs[0].archived).toBe(false);

    ws.send(JSON.stringify({ type: "snap.run", run: { ...visible, archived: true } }));
    await Bun.sleep(40);
    const hiddenList = await (await fetch(url(s, "/mobile/runs"), { headers })).json() as any;
    expect(hiddenList.runs.map((r: any) => r.runId)).not.toContain("r-1");
    const archived = await (await fetch(url(s, "/mobile/runs?archived=1"), { headers })).json() as any;
    expect(archived.runs.map((r: any) => r.runId)).toContain("r-1");
    expect(archived.runs[0].archived).toBe(true);
    const got = await (await fetch(url(s, "/mobile/runs/r-1"), { headers })).json() as any;
    expect(got.archived).toBe(true);
    expect(got.finalText).toBe("好了");
    ws.close();
  });

  test("archive and unarchive roundtrip with fake hub", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    autoHub(ws);
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-1",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello fleet",
        status: "completed",
        finalText: "好了",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const a = await fetch(url(s, "/mobile/runs/r-1/archive"), { method: "POST", headers });
    expect(a.status).toBe(200);
    const archived = await a.json() as any;
    expect(archived.run.archived).toBe(true);
    const open = await (await fetch(url(s, "/mobile/runs"), { headers })).json() as any;
    expect(open.runs.map((r: any) => r.runId)).not.toContain("r-1");

    const u = await fetch(url(s, "/mobile/runs/r-1/unarchive"), { method: "POST", headers });
    expect(u.status).toBe(200);
    const back = await u.json() as any;
    expect(back.run.archived).toBe(false);
    const open2 = await (await fetch(url(s, "/mobile/runs"), { headers })).json() as any;
    expect(open2.runs.map((r: any) => r.runId)).toContain("r-1");
    ws.close();
  });

  test("archive of unknown run is 404 without hub command", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const r = await fetch(url(s, "/mobile/runs/nope/archive"), { method: "POST", headers });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "NOT_FOUND" });
    ws.close();
  });

  test("archive occupying is 409 INVALID_STATE and snap unchanged", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "cmd.archive") {
        ws.send(JSON.stringify({
          type: "cmd.result",
          requestId: msg.requestId,
          ok: false,
          error: "INVALID_STATE",
        }));
      }
    });
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-live",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello fleet",
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const r = await fetch(url(s, "/mobile/runs/r-live/archive"), { method: "POST", headers });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "INVALID_STATE" });
    const list = await (await fetch(url(s, "/mobile/runs"), { headers })).json() as any;
    expect(list.runs.map((x: any) => x.runId)).toContain("r-live");
    expect(list.runs[0].archived).toBe(false);
    ws.close();
  });

  test("stale hub socket close does not mark a newer connection offline", async () => {
    const s = start();
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    const oldWs = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const newWs = await connectHub(s, fleet.fleet, fleet.hubSecret);
    newWs.send(JSON.stringify({
      type: "snap.workspaces",
      machines: [{ id: "m-1", name: "A", status: "online", openWorkspaces: ["/ws/a"] }],
    }));
    oldWs.close();
    await Bun.sleep(80);
    const list = await (await fetch(url(s, "/mobile/workspaces"), { headers })).json() as any;
    expect(list.hubOffline).toBe(false);
    expect(list.workspaces[0]?.workspaceRoot).toBe("/ws/a");
    newWs.close();
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
