import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

async function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-chat-api-"));
  hub = createServer({ port: 0, home });
  const ws: WebSocket = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  ws.send(JSON.stringify({
    type: "register", machineId: "m-1", windowId: "w-1", name: "Mac-A",
    os: "darwin-arm64", openWorkspaces: ["/ws/a"], cdpReady: true,
  }));
  await new Promise((r) => setTimeout(r, 80));
  const api = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${hub!.port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}`, ...(init?.headers ?? {}) },
    });
  return { api };
}

function insertEvent(runId: string, seq: number, source: string, payload: object, hook: string | null = null) {
  hub!.db.query(
    `INSERT INTO run_events (run_id, seq, machine_id, ext_seq, source, hook_event_name, payload, ts, post_terminal)
     VALUES (?1,?2,'m-1',?2,?3,?4,?5,?6,0)`,
  ).run(runId, seq, source, hook, JSON.stringify(payload), seq);
}

describe("GET /api/runs/:id/chat", () => {
  test("returns user lines and final assistant bodies, not thoughts", async () => {
    const { api } = await start();
    const created = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "第一问" }),
    });
    const { run } = await created.json() as { run: { id: string } };
    insertEvent(run.id, 1, "hook", { prompt: "第一问" }, "beforeSubmitPrompt");
    insertEvent(run.id, 2, "hook", { text: "想一下" }, "afterAgentThought");
    insertEvent(run.id, 3, "hook", { text: "第一答" }, "afterAgentResponse");
    insertEvent(run.id, 4, "hook", { prompt: "第二问" }, "beforeSubmitPrompt");
    insertEvent(run.id, 5, "hook", { text: "第二答" }, "afterAgentResponse");
    const r = await api(`/api/runs/${run.id}/chat`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      turns: [
        { role: "user", text: "第一问" },
        { role: "assistant", text: "第一答" },
        { role: "user", text: "第二问" },
        { role: "assistant", text: "第二答" },
      ],
    });
    expect((await api("/api/runs/nope/chat")).status).toBe(404);
  });
});
