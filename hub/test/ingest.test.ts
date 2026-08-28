import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

async function startBoundRun() {
  const home = mkdtempSync(join(tmpdir(), "armada-ing-"));
  hub = createServer({ port: 0, home });
  const ws: WebSocket = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const inbound: any[] = [];
  ws.addEventListener("message", (e) => inbound.push(JSON.parse(String(e.data))));
  ws.send(JSON.stringify({ type: "register", machineId: "m-1", windowId: "w-1", name: "A", os: "darwin", openWorkspaces: ["/ws/a"] }));
  await new Promise((r) => setTimeout(r, 100));
  const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${hub!.port}${p}`, {
    ...init, headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}` },
  });
  const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hi" }) });
  const { run } = await r.json() as any;
  ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
  ws.send(JSON.stringify({ type: "run.bound", runId: run.id, conversationId: "cid-1", transcriptPath: "/tmp/t.jsonl", promptMatch: true }));
  await new Promise((r2) => setTimeout(r2, 100));
  return { ws, inbound, api, runId: run.id as string };
}

function ev(runId: string, seq: number, hook: string, payload: any) {
  return { type: "run.event", runId, source: "hook", hookEventName: hook, payload, ts: Date.now(), seq };
}

describe("event ingest", () => {
  test("events get per-run seq and are queryable; ack sent back", async () => {
    const { ws, inbound, api, runId } = await startBoundRun();
    ws.send(JSON.stringify(ev(runId, 1, "preToolUse", { tool_name: "Shell" })));
    ws.send(JSON.stringify(ev(runId, 2, "postToolUse", { tool_name: "Shell", duration_ms: 42 })));
    await new Promise((r) => setTimeout(r, 150));
    const events = (await (await api(`/api/runs/${runId}/events`)).json()) as any[];
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0].hook_event_name).toBe("preToolUse");
    const acks = inbound.filter((m) => m.type === "event.ack");
    expect(acks.at(-1)).toEqual({ type: "event.ack", machineId: "m-1", lastSeq: 2 });
    ws.close();
  });

  test("duplicate ext_seq is deduped but still acked", async () => {
    const { ws, inbound, api, runId } = await startBoundRun();
    ws.send(JSON.stringify(ev(runId, 1, "preToolUse", { tool_name: "Shell" })));
    ws.send(JSON.stringify(ev(runId, 1, "preToolUse", { tool_name: "Shell" })));
    await new Promise((r) => setTimeout(r, 150));
    expect((await (await api(`/api/runs/${runId}/events`)).json()) as any[]).toHaveLength(1);
    expect(inbound.filter((m) => m.type === "event.ack").length).toBeGreaterThanOrEqual(2);
    ws.close();
  });

  test("stop completed → run completed; later events flagged post_terminal", async () => {
    const { ws, api, runId } = await startBoundRun();
    ws.send(JSON.stringify(ev(runId, 1, "stop", { status: "completed" })));
    await new Promise((r) => setTimeout(r, 100));
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("completed");
    ws.send(JSON.stringify(ev(runId, 2, "sessionEnd", {})));
    await new Promise((r) => setTimeout(r, 100));
    const events = (await (await api(`/api/runs/${runId}/events`)).json()) as any[];
    expect(events[1].post_terminal).toBe(1);
    ws.close();
  });

  test("cancel requested → stop aborted → cancelled", async () => {
    const { ws, inbound, api, runId } = await startBoundRun();
    const cr = await api(`/api/runs/${runId}/cancel`, { method: "POST" });
    expect(cr.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    const cancelMsg = inbound.find((m) => m.type === "run.cancel");
    expect(cancelMsg).toMatchObject({ runId, conversationId: "cid-1" });
    ws.send(JSON.stringify(ev(runId, 1, "stop", { status: "aborted" })));
    await new Promise((r) => setTimeout(r, 100));
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("cancelled");
    ws.close();
  });

  test("natural abort (no cancel request) → aborted", async () => {
    const { ws, api, runId } = await startBoundRun();
    ws.send(JSON.stringify(ev(runId, 1, "stop", { status: "aborted" })));
    await new Promise((r) => setTimeout(r, 100));
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("aborted");
    ws.close();
  });

  test("events resolvable by conversationId when runId absent", async () => {
    const { ws, api, runId } = await startBoundRun();
    const msg = ev("", 1, "afterAgentResponse", { text: "hi" });
    delete (msg as any).runId;
    (msg as any).conversationId = "cid-1";
    ws.send(JSON.stringify(msg));
    await new Promise((r) => setTimeout(r, 100));
    expect((await (await api(`/api/runs/${runId}/events`)).json()) as any[]).toHaveLength(1);
    ws.close();
  });

  test("SSE stream receives events for the run", async () => {
    const { ws, runId } = await startBoundRun();
    const ac = new AbortController();
    const resp = await fetch(`http://127.0.0.1:${hub!.port}/api/runs/${runId}/stream?token=${hub!.token}`, { signal: ac.signal });
    expect(resp.status).toBe(200);
    const reader = resp.body!.getReader();
    ws.send(JSON.stringify(ev(runId, 1, "preToolUse", { tool_name: "Grep" })));
    let text = "";
    for (let i = 0; i < 10 && !text.includes("preToolUse"); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("preToolUse");
    ac.abort();
    ws.close();
  });

  test("audit export returns JSONL", async () => {
    const { api } = await startBoundRun();
    const r = await api("/api/audit/export");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body.trim().split("\n").length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(body.trim().split("\n")[0])).toHaveProperty("action");
  });
});
