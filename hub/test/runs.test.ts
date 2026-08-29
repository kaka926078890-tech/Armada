import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

async function startWithExt() {
  const home = mkdtempSync(join(tmpdir(), "armada-runs-"));
  hub = createServer({ port: 0, home });
  const ws: WebSocket = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const inbound: any[] = [];
  ws.addEventListener("message", (e) => inbound.push(JSON.parse(String(e.data))));
  ws.send(JSON.stringify({
    type: "register", machineId: "m-1", windowId: "w-1", name: "Mac-A",
    os: "darwin-arm64", openWorkspaces: ["/ws/a"],
  }));
  await new Promise((r) => setTimeout(r, 100));
  inbound.length = 0; // drop "registered"
  const api = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${hub!.port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}`, ...(init?.headers ?? {}) },
    });
  return { ws, inbound, api };
}

describe("Run dispatch", () => {
  test("POST /api/runs happy path: dispatched → binding → running", async () => {
    const { ws, inbound, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hello" }) });
    expect(r.status).toBe(201);
    const { run } = await r.json() as any;
    expect(run.status).toBe("dispatched");
    await new Promise((r2) => setTimeout(r2, 100));
    const start = inbound.find((m) => m.type === "run.start");
    expect(start).toMatchObject({ runId: run.id, workspaceRoot: "/ws/a", prompt: "hello" });

    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    await new Promise((r2) => setTimeout(r2, 100));
    expect(((await (await api(`/api/runs/${run.id}`)).json()) as any).status).toBe("binding");

    ws.send(JSON.stringify({ type: "run.bound", runId: run.id, conversationId: "cid-1", transcriptPath: "/tmp/t.jsonl", promptMatch: false }));
    await new Promise((r2) => setTimeout(r2, 100));
    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("running");
    expect(after.conversation_id).toBe("cid-1");
    ws.close();
  });

  test("rejects offline machine (400 MACHINE_OFFLINE)", async () => {
    const { api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "ghost", workspaceRoot: "/ws/a", prompt: "x" }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("MACHINE_OFFLINE");
  });

  test("rejects workspace not open (400 WORKSPACE_NOT_OPEN)", async () => {
    const { api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/nope", prompt: "x" }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("WORKSPACE_NOT_OPEN");
  });

  test("rejects busy machine (409 RUN_BUSY)", async () => {
    const { api } = await startWithExt();
    const r1 = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "a" }) });
    expect(r1.status).toBe(201);
    const r2 = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "b" }) });
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as any).error).toBe("RUN_BUSY");
  });

  test("rejected ack → error with reason", async () => {
    const { ws, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "x" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "rejected", reason: "NOT_AUTHORIZED" }));
    await new Promise((r2) => setTimeout(r2, 100));
    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("error");
    expect(after.end_reason).toBe("NOT_AUTHORIZED");
    ws.close();
  });

  test("dispatch timeout → error/DISPATCH_TIMEOUT", async () => {
    const { api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "x" }) });
    const { run } = await r.json() as any;
    hub!.db.query("UPDATE runs SET created_at=?1 WHERE id=?2").run(Date.now() - 35_000, run.id);
    hub!.runs.sweepTimeouts();
    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("error");
    expect(after.end_reason).toBe("DISPATCH_TIMEOUT");
  });

  test("迟到的 accepted ack 从 DISPATCH_TIMEOUT 收回为 binding", async () => {
    const { ws, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "x" }) });
    const { run } = await r.json() as any;
    hub!.db.query("UPDATE runs SET created_at=?1 WHERE id=?2").run(Date.now() - 35_000, run.id);
    hub!.runs.sweepTimeouts();
    expect(((await (await api(`/api/runs/${run.id}`)).json()) as any).end_reason).toBe("DISPATCH_TIMEOUT");
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    await new Promise((r2) => setTimeout(r2, 100));
    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("binding");
    expect(after.end_reason).toBeNull();
    hub!.runs.sweepTimeouts();
    expect(((await (await api(`/api/runs/${run.id}`)).json()) as any).status).toBe("binding");
    ws.close();
  });

  test("machine offline → running run becomes unknown", async () => {
    const { ws, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "x" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId: run.id, conversationId: "cid-1", transcriptPath: null, promptMatch: false }));
    await new Promise((r2) => setTimeout(r2, 100));
    hub!.runs.onMachineOffline("m-1");
    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("unknown");
    ws.close();
  });

  test("audit rows written for create + transitions", async () => {
    const { ws, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "x" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    await new Promise((r2) => setTimeout(r2, 100));
    const rows = hub!.db.query("SELECT action FROM audit WHERE target=?1 ORDER BY id").all(run.id) as any[];
    expect(rows.map((x) => x.action)).toEqual(["run.create", "run.dispatched", "run.binding"]);
    ws.close();
  });

  test("followup of an old run must not BIND_TIMEOUT on original created_at", async () => {
    const { ws, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "a" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId: run.id, conversationId: "cid-1", transcriptPath: null, promptMatch: true }));
    ws.send(JSON.stringify({ type: "run.event", runId: run.id, source: "hook", hookEventName: "stop", payload: { status: "completed" }, ts: Date.now(), seq: 1 }));
    await new Promise((r2) => setTimeout(r2, 150));
    hub!.db.query("UPDATE runs SET created_at=?1 WHERE id=?2").run(Date.now() - 120_000, run.id);
    const f = await api(`/api/runs/${run.id}/followup`, { method: "POST", body: JSON.stringify({ prompt: "继续" }) });
    expect(f.status).toBe(200);
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    await new Promise((r2) => setTimeout(r2, 100));
    hub!.runs.sweepTimeouts();
    expect(((await (await api(`/api/runs/${run.id}`)).json()) as any).status).toBe("binding");
    ws.close();
  });

  test("followup reopens the same run (same card) and sends run.followup", async () => {
    const { ws, inbound, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "a" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId: run.id, conversationId: "cid-1", transcriptPath: null, promptMatch: true }));
    ws.send(JSON.stringify({ type: "run.event", runId: run.id, source: "hook", hookEventName: "stop", payload: { status: "completed" }, ts: Date.now(), seq: 1 }));
    await new Promise((r2) => setTimeout(r2, 150));
    inbound.length = 0;
    const f = await api(`/api/runs/${run.id}/followup`, { method: "POST", body: JSON.stringify({ prompt: "继续" }) });
    expect(f.status).toBe(200);
    const { run: again } = await f.json() as any;
    expect(again.id).toBe(run.id);
    expect(again.status).toBe("dispatched");
    expect(again.ended_at).toBeNull();
    expect(again.parent_run_id).toBeNull();
    await new Promise((r2) => setTimeout(r2, 100));
    expect(inbound.find((m) => m.type === "run.start")).toBeUndefined();
    expect(inbound.find((m) => m.type === "run.followup")).toMatchObject({
      runId: run.id, conversationId: "cid-1", workspaceRoot: "/ws/a", prompt: "继续",
    });
    const listed = (await (await api("/api/runs")).json()) as any[];
    expect(listed.filter((x) => x.conversation_id === "cid-1")).toHaveLength(1);
    ws.close();
  });

  test("followup on operator-closed parent → 400 CLOSED", async () => {
    const { ws, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "a" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "rejected", reason: "boom" }));
    await new Promise((r2) => setTimeout(r2, 100));
    expect((await api(`/api/runs/${run.id}/close`, { method: "POST" })).status).toBe(200);
    // closed runs may still have conversation_id from a prior bind; force one so we hit CLOSED not NO_CONVERSATION
    hub!.db.query("UPDATE runs SET conversation_id=?1 WHERE id=?2").run("cid-closed", run.id);
    const f = await api(`/api/runs/${run.id}/followup`, { method: "POST", body: JSON.stringify({ prompt: "续" }) });
    expect(f.status).toBe(400);
    expect(((await f.json()) as any).error).toBe("CLOSED");
    ws.close();
  });

  test("close: error → cancelled via setStatus + SSE broadcast + audit", async () => {
    const { ws, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "x" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "rejected", reason: "boom" }));
    await new Promise((r2) => setTimeout(r2, 100));
    expect(((await (await api(`/api/runs/${run.id}`)).json()) as any).status).toBe("error");

    const ac = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${hub!.port}/api/runs/${run.id}/stream?token=${hub!.token}`, { signal: ac.signal });
    const reader = stream.body!.getReader();
    await reader.read(); // drain :ok

    const closeRes = await api(`/api/runs/${run.id}/close`, { method: "POST" });
    expect(closeRes.status).toBe(200);

    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("cancelled");
    expect(after.end_reason).toBe("OPERATOR_CLOSED");

    let sawStatus = false;
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !sawStatus) {
      const result = await Promise.race([
        reader.read().then((x) => ({ kind: "data" as const, ...x })),
        new Promise<{ kind: "timeout" }>((res) => setTimeout(() => res({ kind: "timeout" }), 50)),
      ]);
      if (result.kind === "timeout") continue;
      if (result.done) break;
      const chunk = new TextDecoder().decode(result.value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const msg = JSON.parse(line.slice(6));
        if (msg.type === "run.status" && msg.runId === run.id && msg.status === "cancelled") sawStatus = true;
      }
    }
    expect(sawStatus).toBe(true);

    const audit = hub!.db.query("SELECT action FROM audit WHERE target=?1 AND action='run.cancelled'").all(run.id) as any[];
    expect(audit.length).toBeGreaterThanOrEqual(1);
    ac.abort();
    ws.close();
  });

  test("close: running → 409 INVALID_STATE", async () => {
    const { ws, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "x" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId: run.id, conversationId: "cid-1", transcriptPath: null, promptMatch: false }));
    await new Promise((r2) => setTimeout(r2, 100));
    expect(((await (await api(`/api/runs/${run.id}`)).json()) as any).status).toBe("running");

    const closeRes = await api(`/api/runs/${run.id}/close`, { method: "POST" });
    expect(closeRes.status).toBe(409);
    expect(((await closeRes.json()) as any).error).toBe("INVALID_STATE");
    expect(((await (await api(`/api/runs/${run.id}`)).json()) as any).status).toBe("running");
    ws.close();
  });
});
