import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

describe("GET /api/runs/:id/events pagination", () => {
  test("default page is 500; afterSeq returns the rest including later replies", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-evpage-"));
    hub = createServer({ port: 0, home });
    const ws: WebSocket = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w); w.onerror = rej;
    });
    ws.send(JSON.stringify({ type: "register", machineId: "m-1", windowId: "w-1", name: "A", os: "darwin", openWorkspaces: ["/ws/a"] }));
    await new Promise((r) => setTimeout(r, 80));
    const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${hub!.port}${p}`, {
      ...init, headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}` },
    });
    const created = await (await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hi" }) })).json() as any;
    const runId = created.run.id as string;
    ws.send(JSON.stringify({ type: "run.ack", runId, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId, conversationId: "cid-1", transcriptPath: "/tmp/t.jsonl", promptMatch: true }));
    await new Promise((r) => setTimeout(r, 80));

    const insert = hub.db.query(
      `INSERT INTO run_events (run_id, seq, machine_id, ext_seq, source, hook_event_name, payload, ts, post_terminal)
       VALUES (?1,?2,'m-1',?3,'hook',?4,?5,?6,0)`,
    );
    for (let seq = 1; seq <= 520; seq++) {
      const hook = seq === 520 ? "afterAgentResponse" : "preToolUse";
      insert.run(runId, seq, seq, hook, JSON.stringify({ text: seq === 520 ? "done" : "t" }), Date.now());
    }

    const first = await (await api(`/api/runs/${runId}/events`)).json() as any[];
    expect(first).toHaveLength(500);
    expect(first.at(-1).seq).toBe(500);

    const rest = await (await api(`/api/runs/${runId}/events?afterSeq=500`)).json() as any[];
    expect(rest).toHaveLength(20);
    expect(rest.at(-1).seq).toBe(520);
    expect(rest.at(-1).hook_event_name).toBe("afterAgentResponse");
    ws.close();
  });
});
