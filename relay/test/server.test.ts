import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { createConnection, type Socket } from "net";
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

const MAX_BODY = 20 * 1024 * 1024;

function rawMobilePost(
  port: number,
  path: string,
  token: string,
  headers: string[],
  body = "",
  waitMs = 1500,
): Promise<{ status: number; raw: string; ms: number; socket: Socket }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n${headers.join("\r\n")}\r\n\r\n${body}`);
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({ status: Number(raw.split(" ")[1]), raw, ms: Date.now() - t0, socket });
    };
    socket.on("data", (d) => {
      chunks.push(Buffer.from(d));
      const raw = Buffer.concat(chunks).toString("utf8");
      const headEnd = raw.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = raw.slice(0, headEnd);
      const cl = head.match(/content-length:\s*(\d+)/i);
      if (!cl || raw.length - (headEnd + 4) >= Number(cl[1])) finish();
    });
    socket.setTimeout(waitMs, finish);
    socket.on("error", finish);
  });
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
      const atts = Array.isArray(msg.attachmentIds)
        ? msg.attachmentIds.map((id: string) => ({ id, mime: "image/png", name: "shot.png", size: 70 }))
        : undefined;
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
          ...(atts?.length ? { attachments: atts } : {}),
          updatedAt: Date.now(),
        },
      }));
    }
    if (msg.type === "cmd.blobPut") {
      const bytes = Buffer.from(String(msg.bytesBase64 ?? ""), "base64");
      const id = createHash("sha256").update(bytes).digest("hex");
      ws.send(JSON.stringify({
        type: "cmd.result",
        requestId: msg.requestId,
        ok: true,
        blob: { id, sha256: id, mime: msg.mime || "image/png", name: msg.name || "image.png", size: bytes.length },
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

  test("completed without finalText stays completed", async () => {
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
    expect(got.status).toBe("completed");
    expect(got.error).not.toBe("NO_ASSISTANT_BODY");
    expect(got.finalText == null || got.finalText === "").toBe(true);
    expect(got.canRetry).toBe(false);
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

  test("snap.workspaces cursorReload is on the operator list and SSE", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({
      type: "snap.workspaces",
      machines: [{
        id: "m-mac", name: "Mac", os: "darwin", status: "online",
        open_workspaces: JSON.stringify(["/ws/a"]), cdp_ready: true,
      }],
      cursorReload: { pending: { action: "when-idle", vsix: "0.4.33", setAt: 1, notBefore: 1 }, needed: true, neededMachineIds: ["m-win"], notice: "扩展包 armada-agent-0.4.34.vsix 还没有，需要先打包。只点 Reload 不会装上新扩展。" },
    }));
    await Bun.sleep(50);
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    const list = await (await fetch(url(s, "/mobile/workspaces"), { headers })).json() as any;
    expect(list.cursorReload).toMatchObject({ needed: true, neededMachineIds: ["m-win"], notice: "扩展包 armada-agent-0.4.34.vsix 还没有，需要先打包。只点 Reload 不会装上新扩展。" });
    const ac = new AbortController();
    const res = await fetch(url(s, "/mobile/stream"), { headers, signal: ac.signal });
    const sse = openSse(res);
    await sse.waitUntil((ev) => ev.some((e) => (e as { type?: string }).type === "workspaces"));
    const frame = sse.events.find((e) => (e as { type?: string }).type === "workspaces") as {
      cursorReload?: { needed?: boolean; neededMachineIds?: string[] };
    };
    expect(frame.cursorReload).toMatchObject({ needed: true, neededMachineIds: ["m-win"], notice: "扩展包 armada-agent-0.4.34.vsix 还没有，需要先打包。只点 Reload 不会装上新扩展。" });
    ac.abort();
    await sse.cancel();
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
    expect(body.outcome).toBe("injected");
    ws.close();
  });

  test("followup on running run returns outcome queued", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
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
            status: "running",
            outbound: [{ id: "o1", prompt: msg.prompt, expectedMode: "queue", state: "injecting", createdAt: 1 }],
            updatedAt: Date.now(),
          },
        }));
      }
    });
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-1",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello fleet",
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const f = await fetch(url(s, "/mobile/runs/r-1/followup"), {
      method: "POST",
      headers: { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "续" }),
    });
    expect(f.status).toBe(201);
    const queued = await f.json() as any;
    expect(queued.outcome).toBe("queued");
    expect(queued.run.status).toBe("running");
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

  test("answer and cancel of unknown run are 404 without hub command", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const cmds: string[] = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (typeof msg.type === "string" && msg.type.startsWith("cmd.")) cmds.push(msg.type);
    });
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const a = await fetch(url(s, "/mobile/runs/nope/answer"), {
      method: "POST",
      headers,
      body: JSON.stringify({ request_id: "x" }),
    });
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual({ error: "NOT_FOUND" });
    const cxl = await fetch(url(s, "/mobile/runs/nope/cancel"), { method: "POST", headers });
    expect(cxl.status).toBe(404);
    expect(await cxl.json()).toEqual({ error: "NOT_FOUND" });
    await Bun.sleep(30);
    expect(cmds).toEqual([]);
    ws.close();
  });

  test("answer and cancel of another fleet's run are 404", async () => {
    const s = start();
    const owner = s.createFleet();
    const other = s.createFleet();
    const wsOwner = await connectHub(s, owner.fleet, owner.hubSecret);
    const wsOther = await connectHub(s, other.fleet, other.hubSecret);
    autoHub(wsOwner);
    autoHub(wsOther);
    const otherCmds: string[] = [];
    wsOther.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (typeof msg.type === "string" && msg.type.startsWith("cmd.")) otherCmds.push(msg.type);
    });
    wsOwner.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-owned",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello fleet",
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${other.operatorToken}`, "content-type": "application/json" };
    const a = await fetch(url(s, "/mobile/runs/r-owned/answer"), {
      method: "POST",
      headers,
      body: JSON.stringify({ request_id: "x" }),
    });
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual({ error: "NOT_FOUND" });
    const cxl = await fetch(url(s, "/mobile/runs/r-owned/cancel"), { method: "POST", headers });
    expect(cxl.status).toBe(404);
    expect(await cxl.json()).toEqual({ error: "NOT_FOUND" });
    await Bun.sleep(30);
    expect(otherCmds).toEqual([]);
    wsOwner.close();
    wsOther.close();
  });

  test("snap.run from another fleet does not steal the row", async () => {
    const s = start();
    const owner = s.createFleet();
    const other = s.createFleet();
    const wsOwner = await connectHub(s, owner.fleet, owner.hubSecret);
    const wsOther = await connectHub(s, other.fleet, other.hubSecret);
    autoHub(wsOwner);
    autoHub(wsOther);
    wsOwner.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-steal",
        machineId: "m-owner",
        workspaceRoot: "/Users/me/owner",
        prompt: "owner-prompt",
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    wsOther.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-steal",
        machineId: "m-thief",
        workspaceRoot: "/Users/me/thief",
        prompt: "thief-prompt",
        status: "completed",
        finalText: "stolen",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const owned = await fetch(url(s, "/mobile/runs/r-steal"), {
      headers: { authorization: `Bearer ${owner.operatorToken}` },
    });
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({
      runId: "r-steal",
      prompt: "owner-prompt",
      status: "running",
      machineId: "m-owner",
    });
    const stolen = await fetch(url(s, "/mobile/runs/r-steal"), {
      headers: { authorization: `Bearer ${other.operatorToken}` },
    });
    expect(stolen.status).toBe(404);
    wsOwner.close();
    wsOther.close();
  });

  test("answer and cancel share followup checkRate", async () => {
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
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    for (let i = 0; i < 20; i++) {
      const r = await fetch(url(s, "/mobile/runs/r-1/answer"), {
        method: "POST",
        headers,
        body: JSON.stringify({ request_id: `x-${i}` }),
      });
      expect(r.status).toBe(202);
    }
    const limited = await fetch(url(s, "/mobile/runs/r-1/cancel"), { method: "POST", headers });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "RATE_LIMIT" });
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

  const PNG_1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  test("POST /mobile/blobs stores via cmd.blobPut and dispatch keeps attachmentIds", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const seen: any[] = [];
    ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
    autoHub(ws);
    await Bun.sleep(30);
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "shot.png", { type: "image/png" }));
    const up = await fetch(url(s, "/mobile/blobs"), { method: "POST", headers, body: fd });
    expect(up.status).toBe(201);
    const { blob } = await up.json() as { blob: { id: string; sha256: string; mime: string; name: string; size: number } };
    expect(blob.id).toBe(createHash("sha256").update(PNG_1x1).digest("hex"));
    expect(blob.id).toBe(blob.sha256);
    expect(blob.mime).toBe("image/png");
    expect(blob.size).toBe(PNG_1x1.length);
    const put = seen.find((m) => m.type === "cmd.blobPut");
    expect(put.bytesBase64).toBe(PNG_1x1.toString("base64"));
    expect(JSON.stringify(put)).not.toContain(PNG_1x1.toString("base64").slice(0, 12) + "audit");

    const d = await fetch(url(s, "/mobile/runs"), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: encodeWorkspaceId("m-1", "/Users/me/proj"),
        prompt: "",
        attachmentIds: [blob.id],
      }),
    });
    expect(d.status).toBe(201);
    const dispatched = seen.find((m) => m.type === "cmd.dispatch");
    expect(dispatched.attachmentIds).toEqual([blob.id]);
    const body = await d.json() as any;
    expect(body.run.attachments).toEqual([
      { id: blob.id, mime: "image/png", name: "shot.png", size: 70 },
    ]);
    ws.close();
  });

  test("JSON blob chunks assemble into one cmd.blobPut", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const seen: any[] = [];
    ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
    autoHub(ws);
    await Bun.sleep(30);
    const raw = Buffer.alloc(20_000, 9);
    raw[0] = 0x89; raw[1] = 0x50; raw[2] = 0x4e; raw[3] = 0x47;
    const chunk = 6 * 1024;
    const count = Math.ceil(raw.length / chunk);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    let last: Response | undefined;
    for (let i = 0; i < count; i++) {
      const part = raw.subarray(i * chunk, Math.min(raw.length, (i + 1) * chunk));
      last = await fetch(url(s, "/mobile/blobs"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          uploadId: "up-1", name: "shot.png", mime: "image/png", totalSize: raw.length,
          index: i, count, data: part.toString("base64"),
        }),
      });
      if (i < count - 1) expect(last.status).toBe(202);
    }
    expect(last!.status).toBe(201);
    const { blob } = await last!.json() as { blob: { size: number } };
    expect(blob.size).toBe(raw.length);
    const put = seen.find((m) => m.type === "cmd.blobPut");
    expect(put.bytesBase64).toBe(raw.toString("base64"));
    expect(seen.filter((m) => m.type === "cmd.blobPut")).toHaveLength(1);
    ws.close();
  });

  test("JSON prompt chunks assemble into one cmd.dispatch under the uuWAF cap", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const seen: any[] = [];
    ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
    autoHub(ws);
    await Bun.sleep(30);
    const prompt = "派".repeat(4000);
    const raw = Buffer.from(prompt, "utf8");
    const chunk = 6 * 1024;
    const count = Math.ceil(raw.length / chunk);
    const workspaceId = encodeWorkspaceId("m-1", "/Users/me/proj");
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    let last: Response | undefined;
    for (let i = 0; i < count; i++) {
      const part = raw.subarray(i * chunk, Math.min(raw.length, (i + 1) * chunk));
      const body = JSON.stringify({
        uploadId: "prompt-1",
        workspaceId,
        totalSize: raw.length,
        index: i,
        count,
        data: part.toString("base64"),
      });
      expect(Buffer.byteLength(body)).toBeLessThan(10 * 1024);
      last = await fetch(url(s, "/mobile/runs"), {
        method: "POST",
        headers,
        body,
      });
      if (i < count - 1) expect(last.status).toBe(202);
    }
    expect(last!.status).toBe(201);
    const dispatched = seen.find((m) => m.type === "cmd.dispatch");
    expect(dispatched.prompt).toBe(prompt);
    expect(seen.filter((m) => m.type === "cmd.dispatch")).toHaveLength(1);
    const { run } = await last!.json() as { run: { prompt: string } };
    expect(run.prompt).toBe(prompt);
    ws.close();
  });

  test("JSON followup chunks assemble into one cmd.followup", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const seen: any[] = [];
    ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
    autoHub(ws);
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-long",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "first",
        status: "completed",
        conversationId: "cid-1",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(30);
    const prompt = "续".repeat(4000);
    const raw = Buffer.from(prompt, "utf8");
    const chunk = 6 * 1024;
    const count = Math.ceil(raw.length / chunk);
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    let last: Response | undefined;
    for (let i = 0; i < count; i++) {
      const part = raw.subarray(i * chunk, Math.min(raw.length, (i + 1) * chunk));
      last = await fetch(url(s, "/mobile/runs/r-long/followup"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          uploadId: "follow-1",
          totalSize: raw.length,
          index: i,
          count,
          data: part.toString("base64"),
        }),
      });
      if (i < count - 1) expect(last.status).toBe(202);
    }
    expect(last!.status).toBe(200);
    const follow = seen.find((m) => m.type === "cmd.followup");
    expect(follow.prompt).toBe(prompt);
    expect(seen.filter((m) => m.type === "cmd.followup")).toHaveLength(1);
    ws.close();
  });

  test("text dispatch omits attachmentIds on the hub command", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const seen: any[] = [];
    ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
    autoHub(ws);
    await Bun.sleep(30);
    const r = await fetch(url(s, "/mobile/runs"), {
      method: "POST",
      headers: { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: encodeWorkspaceId("m-1", "/Users/me/proj"), prompt: "plain" }),
    });
    expect(r.status).toBe(201);
    const dispatched = seen.find((m) => m.type === "cmd.dispatch");
    expect(dispatched.attachmentIds).toBeUndefined();
    expect(Object.keys(dispatched).sort()).toEqual(["prompt", "requestId", "type", "workspaceId"].sort());
    ws.close();
  });

  test("running followup with attachmentIds is 409 without hub cmd", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const seen: any[] = [];
    ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
    autoHub(ws);
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-live",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hi",
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const sha = "a".repeat(64);
    const f = await fetch(url(s, "/mobile/runs/r-live/followup"), {
      method: "POST",
      headers: { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "看图", attachmentIds: [sha] }),
    });
    expect(f.status).toBe(409);
    expect(await f.json()).toEqual({ error: "OUTBOUND_TEXT_ONLY" });
    expect(seen.some((m) => m.type === "cmd.followup")).toBe(false);
    ws.close();
  });

  test("non-hex attachmentIds are 400 INVALID", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    autoHub(ws);
    await Bun.sleep(20);
    const r = await fetch(url(s, "/mobile/runs"), {
      method: "POST",
      headers: { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: encodeWorkspaceId("m-1", "/ws"),
        prompt: "x",
        attachmentIds: ["nope"],
      }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "INVALID" });
    ws.close();
  });

  test("blob Content-Length over 8 MiB is 413 before 20 MiB gate", async () => {
    const s = start();
    const fleet = s.createFleet();
    const r = await rawMobilePost(s.port, "/mobile/blobs", fleet.operatorToken, [
      "Content-Length: 8388609",
      "Content-Type: multipart/form-data; boundary=x",
    ], "", 800);
    expect(r.status).toBe(413);
    expect(r.raw).toMatch(/ATTACHMENT_TOO_LARGE/);
    r.socket.destroy();
  });
});

describe("relay payload gates", () => {
  test("followup missing Content-Length is 400 without waiting for a body", async () => {
    const s = start();
    const fleet = s.createFleet();
    const r = await rawMobilePost(s.port, "/mobile/runs/r-1/followup", fleet.operatorToken, [
      "Transfer-Encoding: chunked",
      "Content-Type: application/json",
    ], "");
    try {
      expect(r.status).toBe(400);
      expect(r.ms).toBeLessThan(1200);
      expect(r.raw).toMatch(/INVALID/);
    } finally {
      r.socket.destroy();
    }
  });

  test("followup oversized Content-Length is 413 before the body is read", async () => {
    const s = start();
    const fleet = s.createFleet();
    const r = await rawMobilePost(s.port, "/mobile/runs/r-1/followup", fleet.operatorToken, [
      `Content-Length: ${MAX_BODY + 1}`,
      "Content-Type: application/json",
    ], "");
    try {
      expect(r.status).toBe(413);
      expect(r.ms).toBeLessThan(1200);
      expect(r.raw).toMatch(/PAYLOAD_TOO_LARGE/);
    } finally {
      r.socket.destroy();
    }
  });

  test("prompt-snippets PUT oversized Content-Length is 413 before the body is read", async () => {
    const s = start();
    const fleet = s.createFleet();
    const t0 = Date.now();
    const r = await new Promise<{ status: number; raw: string; ms: number; socket: Socket }>((resolve) => {
      const chunks: Buffer[] = [];
      const socket = createConnection({ host: "127.0.0.1", port: s.port }, () => {
        socket.write(`PUT /mobile/prompt-snippets HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${fleet.operatorToken}\r\nContent-Length: ${MAX_BODY + 1}\r\nContent-Type: application/json\r\n\r\n`);
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: Number(raw.split(" ")[1]), raw, ms: Date.now() - t0, socket });
      };
      socket.on("data", (d) => {
        chunks.push(Buffer.from(d));
        const raw = Buffer.concat(chunks).toString("utf8");
        const headEnd = raw.indexOf("\r\n\r\n");
        if (headEnd < 0) return;
        const head = raw.slice(0, headEnd);
        const cl = head.match(/content-length:\s*(\d+)/i);
        if (!cl || raw.length - (headEnd + 4) >= Number(cl[1])) finish();
      });
      socket.setTimeout(1500, finish);
      socket.on("error", finish);
    });
    try {
      expect(r.status).toBe(413);
      expect(r.ms).toBeLessThan(1200);
      expect(r.raw).toMatch(/PAYLOAD_TOO_LARGE/);
    } finally {
      r.socket.destroy();
    }
  });

  test("dispatch oversized Content-Length is 413 before the body is read", async () => {
    const s = start();
    const fleet = s.createFleet();
    const r = await rawMobilePost(s.port, "/mobile/runs", fleet.operatorToken, [
      `Content-Length: ${MAX_BODY + 1}`,
      "Content-Type: application/json",
    ], "");
    try {
      expect(r.status).toBe(413);
      expect(r.ms).toBeLessThan(1200);
      expect(r.raw).toMatch(/PAYLOAD_TOO_LARGE/);
    } finally {
      r.socket.destroy();
    }
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
  test("push-token: no bearer 401, pair 403, unknown environment 400", async () => {
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
      body: JSON.stringify({ token: TOKEN_A, environment: "prod" }),
    });
    expect(badEnv.status).toBe(400);
    expect(await badEnv.json()).toEqual({ error: "INVALID" });
    const sandbox = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "sandbox" }),
    });
    expect(sandbox.status).toBe(204);
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

  test("sandbox token is delivered to api.sandbox.push.apple.com", async () => {
    const urls: string[] = [];
    const s = start({
      apns: dummyApns(async (url) => {
        urls.push(url);
        if (url.includes("api.sandbox.push.apple.com")) return { status: 200 };
        return { status: 400, reason: "BadDeviceToken" };
      }),
    });
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    const reg = await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "sandbox" }),
    });
    expect(reg.status).toBe(204);
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s.flushApns();
    expect(urls.some((u) => u.includes("https://api.sandbox.push.apple.com/3/device/"))).toBe(true);
    expect(urls.some((u) => u.includes("https://api.push.apple.com/3/device/"))).toBe(true);
    ws.close();
  });

  test("sandbox-labeled TestFlight token is delivered on production APNs and stored as production", async () => {
    const urls: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "armada-relay-"));
    const s = start({
      home,
      apns: dummyApns(async (url) => {
        urls.push(url);
        if (url.includes("api.sandbox.push.apple.com")) return { status: 400, reason: "BadDeviceToken" };
        return { status: 200 };
      }),
    });
    const fleet = s.createFleet();
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    expect((await fetch(url(s, "/mobile/push-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN_A, environment: "sandbox" }),
    })).status).toBe(204);
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({ type: "snap.run", run: completedRun() }));
    await Bun.sleep(40);
    await s.flushApns();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("https://api.push.apple.com/3/device/");
    const { Database } = await import("bun:sqlite");
    const row = new Database(join(home, "relay.db")).query(
      "SELECT environment FROM push_tokens WHERE token=?1",
    ).get(TOKEN_A) as { environment: string };
    expect(row.environment).toBe("production");
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

  test("SSE dump and broadcasts strip finalText; GET detail keeps it", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-body",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello",
        status: "completed",
        finalText: "SECRET_SSE_BODY",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    const ac = new AbortController();
    const res = await fetch(url(s, "/mobile/stream"), {
      headers,
      signal: ac.signal,
    });
    const sse = openSse(res);
    await sse.waitUntil((ev) => ev.some((e) => (e as { run?: { runId?: string } }).run?.runId === "r-body"));
    const dumped = sse.events.find((e) => (e as { run?: { runId?: string } }).run?.runId === "r-body") as {
      run: { finalText: string | null };
    };
    expect(dumped.run.finalText).toBeNull();
    const detail = await (await fetch(url(s, "/mobile/runs/r-body"), { headers })).json() as { finalText: string };
    expect(detail.finalText).toBe("SECRET_SSE_BODY");
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-body",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello",
        status: "completed",
        finalText: "SECRET_SSE_BODY_V2",
        updatedAt: Date.now() + 1,
      },
    }));
    await sse.waitUntil((ev) => ev.filter((e) => (e as { run?: { runId?: string } }).run?.runId === "r-body").length >= 2);
    const broadcast = sse.events.filter((e) => (e as { run?: { runId?: string } }).run?.runId === "r-body").at(-1) as {
      run: { finalText: string | null; status: string };
    };
    expect(broadcast.run.finalText).toBeNull();
    expect(broadcast.run.status).toBe("completed");
    const again = await (await fetch(url(s, "/mobile/runs/r-body"), { headers })).json() as { finalText: string };
    expect(again.finalText).toBe("SECRET_SSE_BODY_V2");
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

describe("relay HTTP map and snap fingerprint", () => {
  test("followup ASK_INVALID_OPTION is 409 not 502", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "cmd.followup") {
        ws.send(JSON.stringify({
          type: "cmd.result",
          requestId: msg.requestId,
          ok: false,
          error: "ASK_INVALID_OPTION",
        }));
      }
    });
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
    const r = await fetch(url(s, "/mobile/runs/r-1/followup"), {
      method: "POST",
      headers: { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "继续" }),
    });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "ASK_INVALID_OPTION" });
    ws.close();
  });

  test("answer ASK_INVALID_OPTION is 409 not 502", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "cmd.answer") {
        ws.send(JSON.stringify({
          type: "cmd.result",
          requestId: msg.requestId,
          ok: false,
          error: "ASK_INVALID_OPTION",
        }));
      }
    });
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-1",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello fleet",
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(50);
    const r = await fetch(url(s, "/mobile/runs/r-1/answer"), {
      method: "POST",
      headers: { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "x" }),
    });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "ASK_INVALID_OPTION" });
    ws.close();
  });

  test("answer HUB_TIMEOUT is 502 not 409", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "cmd.answer") {
        ws.send(JSON.stringify({
          type: "cmd.result",
          requestId: msg.requestId,
          ok: false,
          error: "HUB_TIMEOUT",
        }));
      }
    });
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-1",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello fleet",
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(50);
    const r = await fetch(url(s, "/mobile/runs/r-1/answer"), {
      method: "POST",
      headers: { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "HUB_TIMEOUT" });
    ws.close();
  });

  test("cancel HUB_TIMEOUT is 502 not 409", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "cmd.cancel") {
        ws.send(JSON.stringify({
          type: "cmd.result",
          requestId: msg.requestId,
          ok: false,
          error: "HUB_TIMEOUT",
        }));
      }
    });
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-1",
        machineId: "m-1",
        workspaceRoot: "/Users/me/proj",
        prompt: "hello fleet",
        status: "running",
        updatedAt: Date.now(),
      },
    }));
    await Bun.sleep(50);
    const r = await fetch(url(s, "/mobile/runs/r-1/cancel"), {
      method: "POST",
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
    });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "HUB_TIMEOUT" });
    ws.close();
  });

  test("identical snap does not bump updated_at or rebroadcast", async () => {
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
    const snap = {
      runId: "r-fp",
      machineId: "m-1",
      workspaceRoot: "/ws/a",
      prompt: "hi",
      status: "running",
      updatedAt: 1000,
    };
    ws.send(JSON.stringify({ type: "snap.run", run: snap }));
    await sse.waitUntil((ev) => ev.some((e) => (e as { run?: { runId?: string } }).run?.runId === "r-fp"));
    const runEvents = () => sse.events.filter((e) => (e as { run?: { runId?: string } }).run?.runId === "r-fp");
    expect(runEvents()).toHaveLength(1);
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    const first = await (await fetch(url(s, "/mobile/runs/r-fp"), { headers })).json() as { updatedAt: number };
    ws.send(JSON.stringify({ type: "snap.run", run: { ...snap, updatedAt: 9999 } }));
    await Bun.sleep(80);
    expect(runEvents()).toHaveLength(1);
    const second = await (await fetch(url(s, "/mobile/runs/r-fp"), { headers })).json() as { updatedAt: number };
    expect(second.updatedAt).toBe(first.updatedAt);
    ac.abort();
    await sse.cancel();
    ws.close();
  });

  test("pendingAsk request_id change bumps updated_at", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const base = {
      runId: "r-ask",
      machineId: "m-1",
      workspaceRoot: "/ws/a",
      prompt: "hi",
      status: "running",
      updatedAt: 1,
    };
    ws.send(JSON.stringify({ type: "snap.run", run: base }));
    await Bun.sleep(40);
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    ws.send(JSON.stringify({
      type: "snap.run",
      run: { ...base, pendingAsk: { request_id: "ask-1", questions: [] } },
    }));
    await Bun.sleep(40);
    const t1 = (await (await fetch(url(s, "/mobile/runs/r-ask"), { headers })).json() as { updatedAt: number }).updatedAt;
    ws.send(JSON.stringify({
      type: "snap.run",
      run: { ...base, pendingAsk: { request_id: "ask-2", questions: [] } },
    }));
    await Bun.sleep(40);
    const t2 = (await (await fetch(url(s, "/mobile/runs/r-ask"), { headers })).json() as { updatedAt: number }).updatedAt;
    expect(t2).not.toBe(t1);
    ws.close();
  });

  test("persists snap title and conversationId for App GET/SSE", async () => {
    const s = start();
    const fleet = s.createFleet();
    const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-cid",
        machineId: "m-1",
        workspaceRoot: "/ws/a",
        prompt: "第一句很长",
        title: "短标题",
        conversationId: "cid-9",
        status: "running",
        updatedAt: 1,
      },
    }));
    await Bun.sleep(40);
    const got = await (await fetch(url(s, "/mobile/runs/r-cid"), { headers })).json() as {
      title?: string; conversationId?: string | null; updatedAt: number;
    };
    expect(got.title).toBe("短标题");
    expect(got.conversationId).toBe("cid-9");
    const t1 = got.updatedAt;
    ws.send(JSON.stringify({
      type: "snap.run",
      run: {
        runId: "r-cid",
        machineId: "m-1",
        workspaceRoot: "/ws/a",
        prompt: "第一句很长",
        title: "改名",
        conversationId: "cid-9",
        status: "running",
        updatedAt: 2,
      },
    }));
    await Bun.sleep(40);
    const renamed = await (await fetch(url(s, "/mobile/runs/r-cid"), { headers })).json() as {
      title?: string; updatedAt: number;
    };
    expect(renamed.title).toBe("改名");
    expect(renamed.updatedAt).not.toBe(t1);
    ws.close();
  });
});
