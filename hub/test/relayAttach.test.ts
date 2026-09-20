import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { attachWithConfig } from "../src/relayAttach";
import { createRelayServer, type RelayServer } from "../../relay/src/server";
import { encodeWorkspaceId } from "../../relay/src/uri";

let hub: HubServer | null = null;
let relay: RelayServer | null = null;
let attach: { stop: () => void } | null = null;
afterEach(() => {
  attach?.stop(); attach = null;
  hub?.stop(); hub = null;
  relay?.stop(); relay = null;
});

async function waitUntil(fn: () => Promise<boolean> | boolean, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await Bun.sleep(40);
  }
  throw new Error("timeout");
}

describe("relay attach (HTTP hub)", () => {
  test("lists open workspaces and dispatches via loopback /api/runs", async () => {
    const relayHome = mkdtempSync(join(tmpdir(), "armada-relay-"));
    const hubHome = mkdtempSync(join(tmpdir(), "armada-hub-"));
    relay = createRelayServer({
      port: 0, hostname: "127.0.0.1", home: relayHome,
      publicBase: "http://127.0.0.1", adminToken: "adm",
    });
    const fleet = relay.createFleet();
    // No relay.json in hub home → packaged-style hub does not dial out.
    hub = createServer({ port: 0, home: hubHome });
    attach = attachWithConfig(
      { relay: `http://127.0.0.1:${relay.port}`, fleet: fleet.fleet, secret: fleet.hubSecret },
      { hubPort: hub.port, token: hub.token, pollMs: 50 },
    );

    const ext: WebSocket = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w);
      w.onerror = rej;
    });
    ext.send(JSON.stringify({
      type: "register", machineId: "m-1", windowId: "w-1", name: "A", os: "darwin", openWorkspaces: ["/ws/a"], cdpReady: true,
    }));

    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await waitUntil(async () => {
      const j = await (await fetch(`http://127.0.0.1:${relay!.port}/mobile/workspaces`, { headers })).json() as any;
      return j.hubOffline === false && j.workspaces?.[0]?.workspaceRoot === "/ws/a";
    });

    const snippet = { id: "ok-id-01", title: "常用", body: "检查测试" };
    const putSnippets = await fetch(`http://127.0.0.1:${relay.port}/mobile/prompt-snippets`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ snippets: [snippet] }),
    });
    expect(putSnippets.status).toBe(200);
    expect(await putSnippets.json()).toEqual({ snippets: [snippet] });
    const getSnippets = await fetch(`http://127.0.0.1:${relay.port}/mobile/prompt-snippets`, { headers });
    expect(getSnippets.status).toBe(200);
    expect(await getSnippets.json()).toEqual({ snippets: [snippet] });
    const invalidSnippets = await fetch(`http://127.0.0.1:${relay.port}/mobile/prompt-snippets`, {
      method: "PUT",
      headers,
      body: JSON.stringify({}),
    });
    expect(invalidSnippets.status).toBe(400);
    expect(await invalidSnippets.json()).toEqual({ error: "SNIPPET_INVALID" });

    const d = await fetch(`http://127.0.0.1:${relay.port}/mobile/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: encodeWorkspaceId("m-1", "/ws/a"), prompt: "from phone" }),
    });
    expect(d.status).toBe(201);
    const body = await d.json() as any;
    expect(body.run.prompt).toBe("from phone");
    expect(["queued", "dispatched", "binding", "running"]).toContain(body.run.status);
    const local = hub.runs.get(body.run.runId);
    expect(local.prompt).toBe("from phone");

    ext.send(JSON.stringify({ type: "run.ack", runId: body.run.runId, status: "accepted" }));
    ext.send(JSON.stringify({
      type: "run.bound", runId: body.run.runId, conversationId: "cid-1",
      transcriptPath: null, promptMatch: true,
    }));
    ext.send(JSON.stringify({
      type: "run.event", runId: body.run.runId, source: "transcript", seq: 1, ts: Date.now(),
      payload: { role: "assistant", message: { content: [{ type: "text", text: "全文正文" }] } },
    }));
    ext.send(JSON.stringify({
      type: "run.event", runId: body.run.runId, source: "hook", hookEventName: "stop",
      payload: { status: "completed" }, ts: Date.now(), seq: 2,
    }));

    await waitUntil(async () => {
      const j = await (await fetch(`http://127.0.0.1:${relay!.port}/mobile/runs/${body.run.runId}`, { headers })).json() as any;
      return j.status === "completed" && j.finalText === "全文正文";
    });

    const f = await fetch(`http://127.0.0.1:${relay.port}/mobile/runs/${body.run.runId}/followup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "继续" }),
    });
    expect(f.status).toBe(200);
    const followed = await f.json() as any;
    expect(followed.run.runId).toBe(body.run.runId);
    expect(followed.run.prompt).toBe("继续");
    expect(["queued", "dispatched", "binding", "running"]).toContain(followed.run.status);
    expect(hub.runs.get(body.run.runId).prompt).toBe("继续");
    ext.close();
  });

  test("hub archive is pushed even when the run leaves the default list", async () => {
    const relayHome = mkdtempSync(join(tmpdir(), "armada-relay-"));
    const hubHome = mkdtempSync(join(tmpdir(), "armada-hub-"));
    relay = createRelayServer({
      port: 0, hostname: "127.0.0.1", home: relayHome,
      publicBase: "http://127.0.0.1", adminToken: "adm",
    });
    const fleet = relay.createFleet();
    hub = createServer({ port: 0, home: hubHome });
    attach = attachWithConfig(
      { relay: `http://127.0.0.1:${relay.port}`, fleet: fleet.fleet, secret: fleet.hubSecret },
      { hubPort: hub.port, token: hub.token, pollMs: 50 },
    );

    const ext: WebSocket = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w);
      w.onerror = rej;
    });
    ext.send(JSON.stringify({
      type: "register", machineId: "m-1", windowId: "w-1", name: "A", os: "darwin", openWorkspaces: ["/ws/a"], cdpReady: true,
    }));

    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await waitUntil(async () => {
      const j = await (await fetch(`http://127.0.0.1:${relay!.port}/mobile/workspaces`, { headers })).json() as any;
      return j.hubOffline === false && j.workspaces?.[0]?.workspaceRoot === "/ws/a";
    });

    const d = await fetch(`http://127.0.0.1:${relay.port}/mobile/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: encodeWorkspaceId("m-1", "/ws/a"), prompt: "from phone" }),
    });
    const body = await d.json() as any;
    const runId = body.run.runId as string;
    ext.send(JSON.stringify({ type: "run.ack", runId, status: "accepted" }));
    ext.send(JSON.stringify({
      type: "run.bound", runId, conversationId: "cid-1",
      transcriptPath: null, promptMatch: true,
    }));
    ext.send(JSON.stringify({
      type: "run.event", runId, source: "transcript", seq: 1, ts: Date.now(),
      payload: { role: "assistant", message: { content: [{ type: "text", text: "全文正文" }] } },
    }));
    ext.send(JSON.stringify({
      type: "run.event", runId, source: "hook", hookEventName: "stop",
      payload: { status: "completed" }, ts: Date.now(), seq: 2,
    }));
    await waitUntil(async () => {
      const j = await (await fetch(`http://127.0.0.1:${relay!.port}/mobile/runs/${runId}`, { headers })).json() as any;
      return j.status === "completed" && j.finalText === "全文正文";
    });

    const hubHeaders = { authorization: `Bearer ${hub.token}`, "content-type": "application/json" };
    const archived = await fetch(`http://127.0.0.1:${hub.port}/api/runs/${runId}/archive`, { method: "POST", headers: hubHeaders });
    expect(archived.status).toBe(200);

    await waitUntil(async () => {
      const j = await (await fetch(`http://127.0.0.1:${relay!.port}/mobile/runs`, { headers })).json() as any;
      return !j.runs.map((r: any) => r.runId).includes(runId);
    });
    const listed = await (await fetch(`http://127.0.0.1:${relay!.port}/mobile/runs?archived=1`, { headers })).json() as any;
    expect(listed.runs.map((r: any) => r.runId)).toContain(runId);
    ext.close();
  });

  test("cursor-reload get/post via attach does not hang", async () => {
    const relayHome = mkdtempSync(join(tmpdir(), "armada-relay-"));
    const hubHome = mkdtempSync(join(tmpdir(), "armada-hub-"));
    relay = createRelayServer({
      port: 0, hostname: "127.0.0.1", home: relayHome,
      publicBase: "http://127.0.0.1", adminToken: "adm",
    });
    const fleet = relay.createFleet();
    hub = createServer({ port: 0, home: hubHome });
    attach = attachWithConfig(
      { relay: `http://127.0.0.1:${relay.port}`, fleet: fleet.fleet, secret: fleet.hubSecret },
      { hubPort: hub.port, token: hub.token, pollMs: 50 },
    );
    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await waitUntil(async () => {
      const j = await (await fetch(`http://127.0.0.1:${relay!.port}/mobile/workspaces`, { headers })).json() as any;
      return j.hubOffline === false;
    });
    const t0 = Date.now();
    const get = await fetch(`http://127.0.0.1:${relay.port}/mobile/cursor-reload`, { headers });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ needed: false });
    expect(Date.now() - t0).toBeLessThan(3000);
    const post = await fetch(`http://127.0.0.1:${relay.port}/mobile/cursor-reload`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "when-idle" }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toMatchObject({ needed: true, pending: { action: "when-idle" } });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("attach command matrix matches client including Reload and ping", () => {
    const attachSrc = readFileSync(join(import.meta.dir, "../src/relayAttach.ts"), "utf8");
    const clientSrc = readFileSync(join(import.meta.dir, "../src/relayClient.ts"), "utf8");
    const handlerSrc = readFileSync(join(import.meta.dir, "../src/relayCommandHandler.ts"), "utf8");
    expect(attachSrc).toContain("createRelayCommandHandler");
    expect(clientSrc).toContain("createRelayCommandHandler");
    expect(attachSrc).toContain("startRelayHeartbeat");
    expect(clientSrc).toContain("startRelayHeartbeat");
    expect(attachSrc).toContain("extension_version");
    expect(attachSrc).toContain("/api/cursor-reload");
    expect(handlerSrc).toMatch(/\.ping\s*\(/);
    expect(handlerSrc).toContain("cmd.blobPut");
  });

  test("attach blobPut writes hub blobs and dispatch keeps ids", async () => {
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const relayHome = mkdtempSync(join(tmpdir(), "armada-relay-"));
    const hubHome = mkdtempSync(join(tmpdir(), "armada-hub-"));
    relay = createRelayServer({
      port: 0, hostname: "127.0.0.1", home: relayHome,
      publicBase: "http://127.0.0.1", adminToken: "adm",
    });
    const fleet = relay.createFleet();
    hub = createServer({ port: 0, home: hubHome });
    attach = attachWithConfig(
      { relay: `http://127.0.0.1:${relay.port}`, fleet: fleet.fleet, secret: fleet.hubSecret },
      { hubPort: hub.port, token: hub.token, pollMs: 50 },
    );
    const ext: WebSocket = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w);
      w.onerror = rej;
    });
    ext.send(JSON.stringify({
      type: "register", machineId: "m-1", windowId: "w-1", name: "A", os: "darwin", openWorkspaces: ["/ws/a"], cdpReady: true,
    }));
    const headers = { authorization: `Bearer ${fleet.operatorToken}` };
    await waitUntil(async () => {
      const j = await (await fetch(`http://127.0.0.1:${relay!.port}/mobile/workspaces`, { headers })).json() as any;
      return j.hubOffline === false && j.workspaces?.[0]?.workspaceRoot === "/ws/a";
    });
    const fd = new FormData();
    fd.append("file", new File([PNG], "shot.png", { type: "image/png" }));
    const up = await fetch(`http://127.0.0.1:${relay.port}/mobile/blobs`, { method: "POST", headers, body: fd });
    expect(up.status).toBe(201);
    const { blob } = await up.json() as any;
    const d = await fetch(`http://127.0.0.1:${relay.port}/mobile/runs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: encodeWorkspaceId("m-1", "/ws/a"),
        prompt: "see",
        attachmentIds: [blob.id],
      }),
    });
    expect(d.status).toBe(201);
    const body = await d.json() as any;
    expect(JSON.parse(hub.runs.get(body.run.runId).attachments)).toEqual([blob.id]);
    expect(body.run.attachments?.[0]?.id).toBe(blob.id);
    ext.close();
  });
});
