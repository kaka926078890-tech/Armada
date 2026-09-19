import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRelayServer, type RelayServer } from "../src/server";
import { encodeWorkspaceId, parseRelayUri } from "../src/uri";
import type { ApnsConfig, ApnsPost } from "../src/apns";
import type { FcmConfig, FcmPost } from "../src/fcm";

let srv: RelayServer | null = null;
afterEach(() => { srv?.stop(); srv = null; });

function dummyApns(post: ApnsPost): ApnsConfig {
  const dir = mkdtempSync(join(tmpdir(), "armada-apns-"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyPath = join(dir, "key.p8");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  return { keyPath, keyId: "KEYID", teamId: "LW2A4J4KKG", retryDelays: [], post };
}

function dummyFcm(post: FcmPost): FcmConfig {
  const dir = mkdtempSync(join(tmpdir(), "armada-fcm-"));
  const serviceAccountPath = join(dir, "sa.json");
  writeFileSync(serviceAccountPath, JSON.stringify({
    type: "service_account",
    project_id: "armada-remote",
    client_email: "relay@armada-remote.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
  }));
  return { serviceAccountPath, retryDelays: [], accessToken: "tok", post };
}

function start(extra?: { home?: string; apns?: ApnsConfig | null; fcm?: FcmConfig | null; ssePingMs?: number }) {
  const home = extra?.home ?? mkdtempSync(join(tmpdir(), "armada-relay-"));
  srv = createRelayServer({
    port: 0,
    hostname: "127.0.0.1",
    home,
    publicBase: "http://127.0.0.1:8780",
    adminToken: "adm-test",
    apns: extra?.apns,
    fcm: extra?.fcm,
    ssePingMs: extra?.ssePingMs,
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

  test("prompt-snippets hub offline → 503", async () => {
    const s = start();
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    expect((await fetch(url(s, "/mobile/prompt-snippets"), { headers })).status).toBe(503);
    const put = await fetch(url(s, "/mobile/prompt-snippets"), {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ snippets: [] }),
    });
    expect(put.status).toBe(503);
    expect(await put.json()).toEqual({ error: "HUB_OFFLINE" });
  });

  test("prompt-snippets get/put round-trip via fake hub", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "cmd.promptSnippetsGet") {
        ws.send(JSON.stringify({
          type: "cmd.result",
          requestId: msg.requestId,
          ok: true,
          snippets: [{ id: "ok-id-01", title: "t", body: "b" }],
        }));
      }
      if (msg.type === "cmd.promptSnippetsPut") {
        ws.send(JSON.stringify({
          type: "cmd.result",
          requestId: msg.requestId,
          ok: true,
          snippets: msg.snippets,
        }));
      }
    });
    await Bun.sleep(50);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const get = await fetch(url(s, "/mobile/prompt-snippets"), { headers });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ snippets: [{ id: "ok-id-01", title: "t", body: "b" }] });
    const put = await fetch(url(s, "/mobile/prompt-snippets"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ snippets: [{ id: "ok-id-02", title: "x", body: "y" }] }),
    });
    expect(put.status).toBe(200);
    const body = await put.json() as { snippets: unknown[]; run?: unknown };
    expect(body.snippets[0]).toMatchObject({ id: "ok-id-02" });
    expect(body.run).toBeUndefined();
    ws.close();
  });

  test("cursor-reload hub offline → 503", async () => {
    const s = start();
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    expect((await fetch(url(s, "/mobile/cursor-reload"), { headers })).status).toBe(503);
    const post = await fetch(url(s, "/mobile/cursor-reload"), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ action: "when-idle" }),
    });
    expect(post.status).toBe(503);
    expect(await post.json()).toEqual({ error: "HUB_OFFLINE" });
  });

  test("cursor-reload get/post round-trip via fake hub", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "cmd.cursorReloadGet") {
        ws.send(JSON.stringify({
          type: "cmd.result",
          requestId: msg.requestId,
          ok: true,
          cursorReload: { pending: { action: "when-idle", vsix: "0.4.27", setAt: 1, notBefore: 1 }, needed: true },
        }));
      }
      if (msg.type === "cmd.cursorReloadPost") {
        ws.send(JSON.stringify({
          type: "cmd.result",
          requestId: msg.requestId,
          ok: true,
          cursorReload: { pending: msg.action === "skip" ? null : { action: msg.action, vsix: "0.4.27", setAt: 1, notBefore: 1 }, needed: msg.action !== "skip" },
        }));
      }
    });
    await Bun.sleep(50);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const get = await fetch(url(s, "/mobile/cursor-reload"), { headers });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ needed: true, pending: { action: "when-idle" } });
    const post = await fetch(url(s, "/mobile/cursor-reload"), {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "now" }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toMatchObject({ needed: true, pending: { action: "now" } });
    ws.close();
  });

  test("prompt-snippets missing array returns SNIPPET_INVALID via fake hub", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type !== "cmd.promptSnippetsPut") return;
      ws.send(JSON.stringify({
        type: "cmd.result",
        requestId: msg.requestId,
        ok: false,
        error: Array.isArray(msg.snippets) ? "UNEXPECTED_ARRAY" : "SNIPPET_INVALID",
      }));
    });
    await Bun.sleep(50);
    const response = await fetch(url(s, "/mobile/prompt-snippets"), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${fleet.operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "SNIPPET_INVALID" });
    ws.close();
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
      cdpReady: false,
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

  test("snap.workspaces cdp_ready true is injectable on the operator list", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({
      type: "snap.workspaces",
      machines: [{
        id: "m-1", name: "Mac", os: "darwin", status: "online",
        open_workspaces: JSON.stringify(["/ws/a"]), cdp_ready: true,
      }],
    }));
    await Bun.sleep(50);
    const list = await (await fetch(url(s, "/mobile/workspaces"), {
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
    })).json() as any;
    expect(list.workspaces[0].cdpReady).toBe(true);
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
    expect(open.runs[0].finalText).toBeNull();

    ws.send(JSON.stringify({ type: "snap.run", run: { ...visible, archived: true } }));
    await Bun.sleep(40);
    const hiddenList = await (await fetch(url(s, "/mobile/runs"), { headers })).json() as any;
    expect(hiddenList.runs.map((r: any) => r.runId)).not.toContain("r-1");
    const archived = await (await fetch(url(s, "/mobile/runs?archived=1"), { headers })).json() as any;
    expect(archived.runs.map((r: any) => r.runId)).toContain("r-1");
    expect(archived.runs[0].archived).toBe(true);
    expect(archived.runs[0].finalText).toBeNull();
    const byView = await (await fetch(url(s, "/mobile/runs?view=hidden"), { headers })).json() as any;
    expect(byView.runs.map((r: any) => r.runId)).toContain("r-1");
    expect(byView.runs[0].archived).toBe(true);
    expect(byView.runs[0].finalText).toBeNull();
    const got = await (await fetch(url(s, "/mobile/runs/r-1"), { headers })).json() as any;
    expect(got.archived).toBe(true);
    expect(got.finalText).toBe("好了");
    ws.close();
  });

  test("later snap omitting archived does not unhide", async () => {
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
    ws.send(JSON.stringify({ type: "snap.run", run: { ...visible, archived: true } }));
    await Bun.sleep(40);
    const { archived: _archived, ...omitted } = visible;
    ws.send(JSON.stringify({ type: "snap.run", run: omitted }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    const open = await (await fetch(url(s, "/mobile/runs"), { headers })).json() as any;
    expect(open.runs.map((r: any) => r.runId)).not.toContain("r-1");
    const hidden = await (await fetch(url(s, "/mobile/runs?archived=1"), { headers })).json() as any;
    expect(hidden.runs.map((r: any) => r.runId)).toContain("r-1");
    expect(hidden.runs[0].archived).toBe(true);
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
    expect(j.pairUri).not.toContain(j.hubSecret);
  });
});

describe("pair one-time code", () => {
  test("POST /pair redeems code once then 410", async () => {
    const s = start();
    const fleet = s.createFleet();
    expect(fleet.pairUri).not.toContain(fleet.hubSecret);
    const parsed = parseRelayUri(fleet.pairUri);
    if ("error" in parsed || parsed.kind !== "pair" || !parsed.code) throw new Error("expected pair code");
    const body = JSON.stringify({ fleet: fleet.fleet, code: parsed.code });
    const r1 = await fetch(url(s, "/pair"), { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({
      relay: s.publicBase,
      fleet: fleet.fleet,
      secret: fleet.hubSecret,
    });
    const r2 = await fetch(url(s, "/pair"), { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(r2.status).toBe(410);
    expect(await r2.json()).toEqual({ error: "PAIR_USED" });
  });

  test("POST /pair wrong code is 401", async () => {
    const s = start();
    const fleet = s.createFleet();
    const r = await fetch(url(s, "/pair"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fleet: fleet.fleet, code: "c".repeat(64) }),
    });
    expect(r.status).toBe(401);
  });
});

const TOKEN_A = "a".repeat(64);

function completedRun(runId = "r-push", extra: Record<string, unknown> = {}) {
  return {
    runId,
    machineId: "m-1",
    workspaceRoot: "/Users/me/proj",
    prompt: "fix the bug",
    status: "completed",
    finalText: "SECRET_BODY_MUST_NOT_LEAVE",
    updatedAt: Date.now(),
    ...extra,
  };
}

describe("relay APNs", () => {
  test("push-token: no bearer 401, pair 403, non-production 400", async () => {
    const s = start();
    const fleet = s.createFleet();
    expect((await fetch(url(s, "/mobile/push-token"), { method: "POST", body: "{}" })).status).toBe(401);
    const pair = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers: { authorization: `Bearer ${fleet.hubSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN_A, environment: "production" }),
    });
    expect(pair.status).toBe(403);
    expect(await pair.json()).toEqual({ error: "OPERATOR_REQUIRED" });
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const badEnv = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "sandbox" }),
    });
    expect(badEnv.status).toBe(400);
    expect(await badEnv.json()).toEqual({ error: "INVALID" });
    const badTok = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: "zz", environment: "production" }),
    });
    expect(badTok.status).toBe(400);
  });

  test("mock APNs 200: collapse-id, no finalText", async () => {
    const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
    const s = start({
      apns: dummyApns(async (url, headers, body) => {
        posts.push({ url, headers, body });
        return { status: 200 };
      }),
    });
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const reg = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "production" }),
    });
    expect(reg.status).toBe(204);
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s.flushApns();
    expect(posts).toHaveLength(1);
    expect(posts[0].headers["apns-collapse-id"]).toBe("run-r-push");
    const parsed = JSON.parse(posts[0].body);
    expect(parsed.finalText).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("SECRET_BODY_MUST_NOT_LEAVE");
    expect(parsed.kind).toBe("completed");
    expect(parsed.runId).toBe("r-push");
    ws.close();
  });

  test("archiving a completed run does not send another APNs", async () => {
    const posts: string[] = [];
    const s = start({
      apns: dummyApns(async (_u, _h, body) => {
        posts.push(body);
        return { status: 200 };
      }),
    });
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "production" }),
    });
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    autoHub(ws);
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun("r-1", { archived: false }) }));
    await Bun.sleep(40);
    await s.flushApns();
    expect(posts).toHaveLength(1);
    const hide = await fetch(url(s, "/mobile/runs/r-1/archive"), { method: "POST", headers });
    expect(hide.status).toBe(200);
    await Bun.sleep(40);
    await s.flushApns();
    expect(posts).toHaveLength(1);
    ws.close();
  });

  test("first snap already archived does not send APNs", async () => {
    const posts: string[] = [];
    const s = start({
      apns: dummyApns(async (_u, _h, body) => {
        posts.push(body);
        return { status: 200 };
      }),
    });
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "production" }),
    });
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun("r-push", { archived: true }) }));
    await Bun.sleep(40);
    await s.flushApns();
    expect(posts).toHaveLength(0);
    ws.close();
  });

  test("missing key file: snap still writes, post unused", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-relay-"));
    const posts: string[] = [];
    const s = start({
      home,
      apns: {
        keyPath: join(home, "missing.p8"),
        keyId: "KEYID",
        teamId: "LW2A4J4KKG",
        post: async () => {
          posts.push("hit");
          return { status: 200 };
        },
      },
    });
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "production" }),
    });
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s.flushApns();
    const got = await (await fetch(url(s, "/mobile/runs/r-push"), { headers })).json() as { status: string };
    expect(got.status).toBe("completed");
    expect(posts).toEqual([]);
    ws.close();
  });

  test("restart does not backfill a completed run", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-relay-"));
    const posts1: string[] = [];
    const s1 = start({
      home,
      apns: dummyApns(async (_u, _h, body) => {
        posts1.push(body);
        return { status: 200 };
      }),
    });
    const fleet = s1.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await fetch(url(s1, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "production" }),
    });
    const ws1 = await connectHub(s1, fleet.fleet, fleet.hubSecret);
    ws1.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s1.flushApns();
    expect(posts1).toHaveLength(1);
    ws1.close();
    s1.stop();
    srv = null;

    const posts2: string[] = [];
    const s2 = start({
      home,
      apns: dummyApns(async (_u, _h, body) => {
        posts2.push(body);
        return { status: 200 };
      }),
    });
    await s2.flushApns();
    expect(posts2).toHaveLength(0);
    const ws2 = await connectHub(s2, fleet.fleet, fleet.hubSecret);
    ws2.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s2.flushApns();
    expect(posts2).toHaveLength(0);
    ws2.close();
  });

  test("410 deletes token so later edges are not sent", async () => {
    const posts: number[] = [];
    const s = start({
      apns: dummyApns(async () => {
        posts.push(1);
        return { status: 410, reason: "Unregistered" };
      }),
    });
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "production" }),
    });
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s.flushApns();
    expect(posts).toHaveLength(1);
    ws.send(JSON.stringify({ type: "snap.run", run: { ...completedRun(), status: "running", finalText: null } }));
    await Bun.sleep(40);
    await s.flushApns();
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s.flushApns();
    expect(posts).toHaveLength(1);
    const gone = await fetch(url(s, "/mobile/push-token"), {
      method: "DELETE",
      headers,
      body: JSON.stringify({ token: TOKEN_A }),
    });
    expect(gone.status).toBe(204);
    ws.close();
  });
});

const FCM_TOKEN = "dGVzdDp0b2tlbi1mb3ItZmNt:APA91bTestToken_abc-123.xyz";

describe("relay FCM", () => {
  test("push-token: missing platform stays apns; fcm token 204; junk 400", async () => {
    const s = start();
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const apns = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "production" }),
    });
    expect(apns.status).toBe(204);
    const fcm = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: FCM_TOKEN, environment: "production", platform: "fcm" }),
    });
    expect(fcm.status).toBe(204);
    const junk = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: "zz", environment: "production", platform: "fcm" }),
    });
    expect(junk.status).toBe(400);
    const hexAsFcmOk = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "production", platform: "fcm" }),
    });
    expect(hexAsFcmOk.status).toBe(204);
  });

  test("FCM snap hits FCM not APNs and omits finalText", async () => {
    const apnsPosts: string[] = [];
    const fcmPosts: string[] = [];
    const s = start({
      apns: dummyApns(async (_u, _h, body) => {
        apnsPosts.push(body);
        return { status: 200 };
      }),
      fcm: dummyFcm(async (_u, _h, body) => {
        fcmPosts.push(body);
        return { status: 200 };
      }),
    });
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: FCM_TOKEN, environment: "production", platform: "fcm" }),
    });
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s.flushApns();
    expect(apnsPosts).toHaveLength(0);
    expect(fcmPosts).toHaveLength(1);
    const parsed = JSON.parse(fcmPosts[0]);
    expect(parsed.message.data.runId).toBe("r-push");
    expect(parsed.message.data.kind).toBe("completed");
    expect(parsed.message.data.finalText).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("SECRET_BODY_MUST_NOT_LEAVE");
    ws.close();
  });

  test("FCM-only enabled still sends when APNs is disabled", async () => {
    const fcmPosts: string[] = [];
    const s = start({
      apns: null,
      fcm: dummyFcm(async (_u, _h, body) => {
        fcmPosts.push(body);
        return { status: 200 };
      }),
    });
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: FCM_TOKEN, environment: "production", platform: "fcm" }),
    });
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s.flushApns();
    expect(fcmPosts).toHaveLength(1);
    ws.close();
  });
});

function openSse(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: object[] = [];
  const comments: string[] = [];
  const cancel = async () => { try { await reader.cancel(); } catch { /* closed */ } };
  const waitUntil = async (until: (ev: object[], c: string[]) => boolean, ms = 2000) => {
    const deadline = Date.now() + ms;
    if (until(events, comments)) return { events, comments };
    while (Date.now() < deadline) {
      const wait = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(wait).then(() => null),
      ]);
      if (!chunk) break;
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const block of parts) {
        const lines = block.split("\n");
        for (const line of lines) {
          if (line.startsWith(":")) comments.push(line.slice(1).trim());
          if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()) as object);
        }
      }
      if (until(events, comments)) return { events, comments };
    }
    throw new Error(`sse timeout events=${JSON.stringify(events)} comments=${JSON.stringify(comments)}`);
  };
  return { events, comments, waitUntil, cancel };
}

describe("mobile stream", () => {
  test("stream without bearer is 401; query token is ignored", async () => {
    const s = start();
    const fleet = s.createFleet();
    expect((await fetch(url(s, "/mobile/stream"))).status).toBe(401);
    const q = await fetch(url(s, `/mobile/stream?token=${fleet.operatorToken}`));
    expect(q.status).toBe(401);
  });

  test("pair secret on stream is 403 OPERATOR_REQUIRED", async () => {
    const s = start();
    const fleet = s.createFleet();
    const r = await fetch(url(s, "/mobile/stream"), {
      headers: { authorization: `Bearer ${fleet.hubSecret}` },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "OPERATOR_REQUIRED" });
  });

  test("op stream is event-stream, dumps workspaces, then snap.run", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({
      type: "snap.workspaces",
      machines: [{ id: "m-1", name: "Mac", display_name: "Mac Intel", os: "darwin", status: "online", open_workspaces: JSON.stringify(["/Users/me/proj"]) }],
    }));
    await Bun.sleep(30);
    const ac = new AbortController();
    const res = await fetch(url(s, "/mobile/stream"), {
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const sse = openSse(res);
    await sse.waitUntil((ev) => ev.some((e) => (e as { type?: string }).type === "workspaces"));
    const wsEv = sse.events.find((e) => (e as { type?: string }).type === "workspaces") as {
      type: string; hubOffline: boolean; workspaces: { label: string }[];
    };
    expect(wsEv.hubOffline).toBe(false);
    expect(wsEv.workspaces[0]).toMatchObject({ label: "proj" });
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-live",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello",
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await sse.waitUntil((ev) => ev.some((e) => (e as { type?: string }).type === "run" && (e as { run?: { runId?: string } }).run?.runId === "r-live"));
    const runEv = sse.events.find((e) => (e as { run?: { runId?: string } }).run?.runId === "r-live") as { run: { status: string; prompt: string } };
    expect(runEv.run).toMatchObject({ status: "running", prompt: "hello" });
    ac.abort();
    await sse.cancel();
    ws.close();
  });

  test("hub close emits workspaces hubOffline", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const ac = new AbortController();
    const res = await fetch(url(s, "/mobile/stream"), {
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
      signal: ac.signal,
    });
    const sse = openSse(res);
    await sse.waitUntil((ev) => ev.some((e) => (e as { type?: string }).type === "workspaces"));
    ws.close();
    await sse.waitUntil((ev) =>
      ev.some((e) => (e as { type?: string }).type === "workspaces" && (e as { hubOffline?: boolean }).hubOffline === true),
    );
    expect(sse.events.some((e) => (e as { hubOffline?: boolean }).hubOffline === true)).toBe(true);
    ac.abort();
    await sse.cancel();
  });

  test("idle ping comment", async () => {
    const s = start({ ssePingMs: 40 });
    const fleet = s.createFleet();
    const ac = new AbortController();
    const res = await fetch(url(s, "/mobile/stream"), {
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
      signal: ac.signal,
    });
    const sse = openSse(res);
    await sse.waitUntil((_e, c) => c.includes("ping"), 500);
    expect(sse.comments).toContain("ping");
    ac.abort();
    await sse.cancel();
  });
});
