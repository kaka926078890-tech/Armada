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
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("cancelled");
    ws.send(JSON.stringify(ev(runId, 1, "stop", { status: "aborted" })));
    await new Promise((r) => setTimeout(r, 100));
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("cancelled");
    ws.close();
  });

  test("cancel then Windows stop error User aborted stays cancelled not error", async () => {
    const { ws, api, runId } = await startBoundRun();
    expect((await api(`/api/runs/${runId}/cancel`, { method: "POST" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
    ws.send(JSON.stringify(ev(runId, 1, "stop", { status: "error", error: "User aborted request" })));
    await new Promise((r) => setTimeout(r, 100));
    const after = (await (await api(`/api/runs/${runId}`)).json()) as any;
    expect(after.status).toBe("cancelled");
    expect(after.end_reason).toBe("cancelled");
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

  test("global SSE receives exactly one run.status per status change", async () => {
    const { ws, runId } = await startBoundRun();
    const ac = new AbortController();
    const resp = await fetch(`http://127.0.0.1:${hub!.port}/api/events?token=${hub!.token}`, { signal: ac.signal });
    expect(resp.status).toBe(200);
    const reader = resp.body!.getReader();
    // Drain the :ok comment frame so we only count post-subscribe broadcasts.
    await reader.read();
    ws.send(JSON.stringify(ev(runId, 1, "stop", { status: "completed" })));
    const statusMsgs: any[] = [];
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read().then((r) => ({ kind: "data" as const, ...r })),
        new Promise<{ kind: "timeout" }>((res) =>
          setTimeout(() => res({ kind: "timeout" }), Math.min(100, remaining)),
        ),
      ]);
      if (result.kind === "timeout") continue;
      if (result.done) break;
      const chunk = new TextDecoder().decode(result.value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const msg = JSON.parse(line.slice(6));
        if (msg.type === "run.status" && msg.runId === runId && msg.status === "completed") {
          statusMsgs.push(msg);
        }
      }
    }
    expect(statusMsgs).toHaveLength(1);
    ac.abort();
    ws.close();
  });

  test("stop labeled with a completed runId is redirected to the active run on the same conversation", async () => {
    const { ws, api, runId: oldId } = await startBoundRun();
    ws.send(JSON.stringify(ev(oldId, 1, "stop", { status: "completed", conversation_id: "cid-1" })));
    await new Promise((r) => setTimeout(r, 100));
    expect(((await (await api(`/api/runs/${oldId}`)).json()) as any).status).toBe("completed");
    const r2 = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hi2" }) });
    const { run: neu } = await r2.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: neu.id, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId: neu.id, conversationId: "cid-1", transcriptPath: "/tmp/t.jsonl", promptMatch: true }));
    await new Promise((r) => setTimeout(r, 100));
    ws.send(JSON.stringify({
      type: "run.event", runId: oldId, conversationId: "cid-1", source: "hook",
      hookEventName: "stop", payload: { status: "completed", conversation_id: "cid-1" }, ts: Date.now(), seq: 99,
    }));
    await new Promise((r) => setTimeout(r, 150));
    expect(((await (await api(`/api/runs/${neu.id}`)).json()) as any).status).toBe("completed");
    expect(((await (await api(`/api/runs/${oldId}`)).json()) as any).status).toBe("completed");
    ws.close();
  });

  test("stop after false BIND_TIMEOUT still completes the run", async () => {
    const { ws, api, runId } = await startBoundRun();
    hub!.db.query("UPDATE runs SET status='unknown', end_reason='BIND_TIMEOUT', ended_at=?1 WHERE id=?2").run(Date.now(), runId);
    ws.send(JSON.stringify(ev(runId, 9, "stop", { status: "completed" })));
    await new Promise((r) => setTimeout(r, 120));
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("completed");
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

  test("beforeSubmitPrompt without runId binds only when prompt matches the waiting run", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-ing-"));
    hub = createServer({ port: 0, home });
    const ws: WebSocket = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w); w.onerror = rej;
    });
    ws.send(JSON.stringify({ type: "register", machineId: "m-1", windowId: "w-1", name: "A", os: "darwin", openWorkspaces: ["/ws/a"] }));
    await new Promise((r) => setTimeout(r, 100));
    const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${hub!.port}${p}`, {
      ...init, headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}` },
    });
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hi" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    await new Promise((r2) => setTimeout(r2, 80));
    ws.send(JSON.stringify({
      type: "run.event", source: "hook", hookEventName: "beforeSubmitPrompt",
      payload: { conversation_id: "cid-stolen", workspace_roots: ["/ws/a"], prompt: "hi" },
      ts: Date.now(), seq: 1,
    }));
    await new Promise((r2) => setTimeout(r2, 120));
    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("running");
    expect(after.conversation_id).toBe("cid-stolen");
    ws.close();
  });

  test("beforeSubmitPrompt without runId binds Windows path variants of the same workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-ing-"));
    hub = createServer({ port: 0, home });
    const ws: WebSocket = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w); w.onerror = rej;
    });
    const winRoot = "c:\\Users\\PC\\Desktop\\work";
    ws.send(JSON.stringify({
      type: "register", machineId: "m-win", windowId: "w-1", name: "W", os: "win32",
      openWorkspaces: [winRoot],
    }));
    await new Promise((r) => setTimeout(r, 100));
    const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${hub!.port}${p}`, {
      ...init, headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}` },
    });
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-win", workspaceRoot: winRoot, prompt: "你好" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    await new Promise((r2) => setTimeout(r2, 80));
    ws.send(JSON.stringify({
      type: "run.event", source: "hook", hookEventName: "beforeSubmitPrompt",
      payload: {
        conversation_id: "cid-win",
        workspace_roots: ["/C:/Users/PC/Desktop/work"],
        prompt: "你好",
      },
      ts: Date.now(), seq: 1,
    }));
    await new Promise((r2) => setTimeout(r2, 120));
    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("running");
    expect(after.conversation_id).toBe("cid-win");
    ws.close();
  });

  test("beforeSubmitPrompt without runId does not bind a different prompt in the same workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-ing-"));
    hub = createServer({ port: 0, home });
    const ws: WebSocket = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w); w.onerror = rej;
    });
    ws.send(JSON.stringify({ type: "register", machineId: "m-1", windowId: "w-1", name: "A", os: "darwin", openWorkspaces: ["/ws/a"] }));
    await new Promise((r) => setTimeout(r, 100));
    const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${hub!.port}${p}`, {
      ...init, headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}` },
    });
    const r = await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "说一句你好" }) });
    const { run } = await r.json() as any;
    ws.send(JSON.stringify({ type: "run.ack", runId: run.id, status: "accepted" }));
    await new Promise((r2) => setTimeout(r2, 80));
    ws.send(JSON.stringify({
      type: "run.event", source: "hook", hookEventName: "beforeSubmitPrompt",
      payload: { conversation_id: "cid-other", workspace_roots: ["/ws/a"], prompt: "样式优化一下" },
      ts: Date.now(), seq: 1,
    }));
    await new Promise((r2) => setTimeout(r2, 120));
    const after = (await (await api(`/api/runs/${run.id}`)).json()) as any;
    expect(after.status).toBe("binding");
    expect(after.conversation_id).toBeNull();
    expect((await (await api(`/api/runs/${run.id}/events`)).json()) as any[]).toHaveLength(0);
    ws.close();
  });

  test("bound run drops hooks from another conversation_id (same workspace)", async () => {
    const { ws, api, runId } = await startBoundRun();
    ws.send(JSON.stringify(ev(runId, 1, "afterAgentThought", {
      conversation_id: "cid-other", text: "别的标签在说话",
    })));
    ws.send(JSON.stringify(ev(runId, 2, "afterAgentThought", {
      conversation_id: "cid-1", text: "本任务思考",
    })));
    await new Promise((r) => setTimeout(r, 150));
    const events = (await (await api(`/api/runs/${runId}/events`)).json()) as any[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload).text).toBe("本任务思考");
    ws.close();
  });

  test("completed run does not ingest another conversation via cid lookup", async () => {
    const { ws, api, runId } = await startBoundRun();
    ws.send(JSON.stringify(ev(runId, 1, "stop", { status: "completed", conversation_id: "cid-1" })));
    await new Promise((r) => setTimeout(r, 100));
    const stray = ev("", 2, "beforeSubmitPrompt", {
      conversation_id: "cid-idle", workspace_roots: ["/ws/a"], prompt: "闲聊",
    });
    delete (stray as any).runId;
    (stray as any).conversationId = "cid-idle";
    ws.send(JSON.stringify(stray));
    await new Promise((r) => setTimeout(r, 120));
    const events = (await (await api(`/api/runs/${runId}/events`)).json()) as any[];
    expect(events.filter((e) => e.hook_event_name === "beforeSubmitPrompt")).toHaveLength(0);
    ws.close();
  });

  test("followup then stale transcript stop must not complete before the new user turn", async () => {
    const { ws, api, runId } = await startBoundRun();
    ws.send(JSON.stringify(ev(runId, 1, "stop", { status: "completed" })));
    await new Promise((r) => setTimeout(r, 100));
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("completed");
    const f = await api(`/api/runs/${runId}/followup`, { method: "POST", body: JSON.stringify({ prompt: "Findesk，core还有代码没有提交pr" }) });
    expect(f.status).toBe(200);
    ws.send(JSON.stringify({ type: "run.ack", runId, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId, conversationId: "cid-1", transcriptPath: "/tmp/t.jsonl", promptMatch: true }));
    await new Promise((r) => setTimeout(r, 80));
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("running");
    ws.send(JSON.stringify({
      type: "run.event", runId, source: "transcript", seq: 10,
      payload: { role: "user", message: { content: [{ type: "text", text: "<user_query>\n上传一下77 服务器\n</user_query>" }] } },
      ts: Date.now(),
    }));
    ws.send(JSON.stringify(ev(runId, 11, "stop", { status: "completed" })));
    await new Promise((r) => setTimeout(r, 120));
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("running");
    ws.send(JSON.stringify({
      type: "run.event", runId, source: "transcript", seq: 12,
      payload: { role: "user", message: { content: [{ type: "text", text: "<user_query>\nFindesk，core还有代码没有提交pr\n</user_query>" }] } },
      ts: Date.now(),
    }));
    ws.send(JSON.stringify(ev(runId, 13, "stop", { status: "completed" })));
    await new Promise((r) => setTimeout(r, 120));
    expect(((await (await api(`/api/runs/${runId}`)).json()) as any).status).toBe("completed");
    ws.close();
  });

  test("subagent hooks with parent_conversation_id still attach to the parent run", async () => {
    const { ws, api, runId } = await startBoundRun();
    ws.send(JSON.stringify(ev(runId, 1, "subagentStart", {
      conversation_id: "cid-child",
      parent_conversation_id: "cid-1",
      description: "说一句你好",
    })));
    ws.send(JSON.stringify(ev(runId, 2, "preToolUse", {
      conversation_id: "cid-child",
      parent_conversation_id: "cid-1",
      tool_name: "Grep",
    })));
    await new Promise((r) => setTimeout(r, 150));
    const events = (await (await api(`/api/runs/${runId}/events`)).json()) as any[];
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.hook_event_name)).toEqual(["subagentStart", "preToolUse"]);
    ws.close();
  });
});
