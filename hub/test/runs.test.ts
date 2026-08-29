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
    hub!.db.query("UPDATE runs SET created_at=?1 WHERE id=?2").run(Date.now() - 10_000, run.id);
    hub!.runs.sweepTimeouts();
    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("error");
    expect(after.end_reason).toBe("DISPATCH_TIMEOUT");
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

  test("followup creates child run and sends run.followup (not run.start)", async () => {
    const { ws, inbound, api } = await startWithExt();
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "a" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId: run.id, conversationId: "cid-1", transcriptPath: null, promptMatch: true }));
    ws.send(JSON.stringify({ type: "run.event", runId: run.id, source: "hook", hookEventName: "stop", payload: { status: "completed" }, ts: Date.now(), seq: 1 }));
    await new Promise((r2) => setTimeout(r2, 150));
    inbound.length = 0;
    const f = await api(`/api/runs/${run.id}/followup`, { method: "POST", body: JSON.stringify({ prompt: "继续" }) });
    expect(f.status).toBe(201);
    const { run: child } = await f.json() as any;
    expect(child.parent_run_id).toBe(run.id);
    expect(child.conversation_id).toBe("cid-1");
    await new Promise((r2) => setTimeout(r2, 100));
    expect(inbound.find((m) => m.type === "run.start")).toBeUndefined();
    expect(inbound.find((m) => m.type === "run.followup")).toMatchObject({ runId: child.id, conversationId: "cid-1", prompt: "继续" });
    ws.close();
  });
});
