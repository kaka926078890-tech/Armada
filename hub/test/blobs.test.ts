import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

async function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-blobs-"));
  hub = createServer({ port: 0, home });
  const ws: WebSocket = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const inbound: any[] = [];
  ws.addEventListener("message", (e) => inbound.push(JSON.parse(String(e.data))));
  ws.send(JSON.stringify({
    type: "register", machineId: "m-1", windowId: "w-1", name: "Mac-A",
    os: "darwin-arm64", openWorkspaces: ["/ws/a"], extensionVersion: "0.4.12",
  }));
  await new Promise((r) => setTimeout(r, 80));
  inbound.length = 0;
  const api = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${hub!.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${hub!.token}`, ...(init?.headers ?? {}) },
    });
  return { ws, inbound, api, home };
}

describe("blobs + image runs", () => {
  test("POST png blob then GET bytes match", async () => {
    const { api, ws } = await start();
    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "a.png", { type: "image/png" }));
    const up = await api("/api/blobs", { method: "POST", body: fd });
    expect(up.status).toBe(201);
    const { blob } = await up.json() as any;
    expect(blob.size).toBe(PNG_1x1.length);
    const got = await api(`/api/blobs/${blob.id}`);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG_1x1)).toBe(true);
    ws.close();
  });

  test("rejects oversize blob with 413", async () => {
    const { api, ws } = await start();
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(8 * 1024 * 1024)]);
    const fd = new FormData();
    fd.append("file", new File([big], "big.png", { type: "image/png" }));
    const up = await api("/api/blobs", { method: "POST", body: fd });
    expect(up.status).toBe(413);
    ws.close();
  });

  test("empty prompt without attachments is 400", async () => {
    const { api, ws } = await start();
    const r = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "  " }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("EMPTY_PROMPT");
    ws.close();
  });

  test("image-only run.start includes attachments; queued promote keeps them", async () => {
    const { api, inbound, ws } = await start();
    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "a.png", { type: "image/png" }));
    const { blob } = await (await api("/api/blobs", { method: "POST", body: fd })).json() as any;

    const firstRes = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hold slot" }),
    });
    expect(firstRes.status).toBe(201);
    const { run: hold } = await firstRes.json() as any;

    const second = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "", attachmentIds: [blob.id] }),
    });
    expect(second.status).toBe(201);
    const { run } = await second.json() as any;
    expect(run.status).toBe("queued");

    inbound.length = 0;
    ws.send(JSON.stringify({ type: "run.ack", runId: hold.id, status: "rejected", reason: "NOT_AUTHORIZED" }));
    await new Promise((r) => setTimeout(r, 120));
    const startMsg = inbound.find((m) => m.type === "run.start" && m.runId === run.id);
    expect(startMsg?.attachments?.[0]?.sha256).toBe(blob.id);
    expect(startMsg?.prompt).toBe("");
    ws.close();
  });

  test("IMAGE_PASTE_FAILED after DISPATCH_TIMEOUT still lands", async () => {
    const { api, ws } = await start();
    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "a.png", { type: "image/png" }));
    const { blob } = await (await api("/api/blobs", { method: "POST", body: fd })).json() as any;
    const r = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "see", attachmentIds: [blob.id] }),
    });
    const { run } = await r.json() as any;
    hub!.db.query("UPDATE runs SET status='error', end_reason='DISPATCH_TIMEOUT', ended_at=?1 WHERE id=?2").run(Date.now(), run.id);
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "rejected", reason: "IMAGE_PASTE_FAILED" }));
    await new Promise((x) => setTimeout(x, 80));
    const after = await (await api(`/api/runs/${run.id}`)).json() as any;
    expect(after.end_reason).toBe("IMAGE_PASTE_FAILED");
    ws.close();
  });

  test("rejects gif as ATTACHMENT_INVALID_MIME", async () => {
    const { api, ws } = await start();
    const gif = Buffer.from("GIF89a");
    const fd = new FormData();
    fd.append("file", new File([gif], "a.gif", { type: "image/gif" }));
    const up = await api("/api/blobs", { method: "POST", body: fd });
    expect(up.status).toBe(400);
    expect(((await up.json()) as any).error).toBe("ATTACHMENT_INVALID_MIME");
    ws.close();
  });

  test("create with 5 attachment ids is 400 ATTACHMENT_COUNT", async () => {
    const { api, ws } = await start();
    const r = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId: "m-1", workspaceRoot: "/ws/a", prompt: "x",
        attachmentIds: ["a", "b", "c", "d", "e"],
      }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("ATTACHMENT_COUNT");
    ws.close();
  });

  test("create total size over 24 MiB is 413", async () => {
    const { api, ws } = await start();
    const now = Date.now();
    hub!.db.query("INSERT INTO blobs (sha256, mime, size, refcount, created_at) VALUES (?1,?2,?3,0,?4)")
      .run("id-a", "image/png", 13 * 1024 * 1024, now);
    hub!.db.query("INSERT INTO blobs (sha256, mime, size, refcount, created_at) VALUES (?1,?2,?3,0,?4)")
      .run("id-b", "image/png", 13 * 1024 * 1024, now);
    const r = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId: "m-1", workspaceRoot: "/ws/a", prompt: "see",
        attachmentIds: ["id-a", "id-b"],
      }),
    });
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error).toBe("ATTACHMENT_TOTAL_TOO_LARGE");
    ws.close();
  });

  test("same empty prompt + same attachment ids collide", async () => {
    const { api, ws } = await start();
    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "a.png", { type: "image/png" }));
    const { blob } = await (await api("/api/blobs", { method: "POST", body: fd })).json() as any;
    const body = { machineId: "m-1", workspaceRoot: "/ws/a", prompt: "", attachmentIds: [blob.id] };
    const first = await api("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(first.status).toBe(201);
    const second = await api("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error).toBe("PROMPT_COLLISION");
    ws.close();
  });

  test("image-only followup records user line only after accepted", async () => {
    const { api, ws } = await start();
    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "a.png", { type: "image/png" }));
    const { blob } = await (await api("/api/blobs", { method: "POST", body: fd })).json() as any;
    const created = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "first" }),
    });
    const { run } = await created.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId: run.id, conversationId: "cid-1", transcriptPath: null, promptMatch: true }));
    ws.send(JSON.stringify({
      type: "run.event", runId: run.id, source: "hook", hookEventName: "stop",
      payload: { status: "completed" }, ts: Date.now(), seq: 1,
    }));
    await new Promise((r) => setTimeout(r, 120));

    const fu = await api(`/api/runs/${run.id}/followup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "", attachmentIds: [blob.id] }),
    });
    expect(fu.status).toBe(200);
    const beforeAck = await (await api(`/api/runs/${run.id}/events`)).json() as any[];
    const hubUsers = beforeAck.filter((e) => e.source === "hub" && e.hook_event_name === "beforeSubmitPrompt");
    expect(hubUsers).toHaveLength(0);

    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    await new Promise((r) => setTimeout(r, 80));
    const afterAck = await (await api(`/api/runs/${run.id}/events`)).json() as any[];
    const recorded = afterAck.filter((e) => e.source === "hub" && e.hook_event_name === "beforeSubmitPrompt");
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0].payload).attachmentIds).toEqual([blob.id]);
    ws.close();
  });
});
