import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

async function startHub() {
  const home = mkdtempSync(join(tmpdir(), "armada-arc-"));
  hub = createServer({ port: 0, home });
  const ws: WebSocket = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  ws.send(JSON.stringify({ type: "register", machineId: "m-1", windowId: "w-1", name: "A.local", os: "darwin", openWorkspaces: ["/ws/a"] }));
  await new Promise((r) => setTimeout(r, 80));
  const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${hub!.port}${p}`, {
    ...init, headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}` },
  });
  return { ws, api };
}

describe("hub archive (hide, not delete)", () => {
  test("default list hides archived run; GET by id still returns it; unarchive restores", async () => {
    const { ws, api } = await startHub();
    const created = await (await api("/api/runs", { method: "POST", body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hi" }) })).json() as any;
    const runId = created.run.id as string;
    ws.send(JSON.stringify({ type: "run.ack", runId, status: "accepted" }));
    ws.send(JSON.stringify({ type: "run.bound", runId, conversationId: "cid-1", transcriptPath: "/tmp/t.jsonl", promptMatch: true }));
    await new Promise((r) => setTimeout(r, 80));
    const live = await (await api(`/api/runs/${runId}/archive`, { method: "POST" })).json() as any;
    expect(live.error).toBe("INVALID_STATE");

    ws.send(JSON.stringify({ type: "run.event", runId, source: "hook", hookEventName: "stop", payload: { status: "completed" }, ts: Date.now(), seq: 1 }));
    await new Promise((r) => setTimeout(r, 80));

    const archived = await (await api(`/api/runs/${runId}/archive`, { method: "POST" })).json() as any;
    expect(archived.run.archived_at).toBeGreaterThan(0);
    const visible = await (await api("/api/runs")).json() as any[];
    expect(visible.map((r) => r.id)).not.toContain(runId);
    const hidden = await (await api("/api/runs?archived=1")).json() as any[];
    expect(hidden.map((r) => r.id)).toContain(runId);
    const still = await (await api(`/api/runs/${runId}`)).json() as any;
    expect(still.id).toBe(runId);
    expect(still.prompt).toBe("hi");

    await api(`/api/runs/${runId}/unarchive`, { method: "POST" });
    const back = await (await api("/api/runs")).json() as any[];
    expect(back.map((r) => r.id)).toContain(runId);
    ws.close();
  });
});

describe("machine display name", () => {
  test("rename survives re-register hostname overwrite", async () => {
    const { ws, api } = await startHub();
    const renamed = await (await api("/api/machines/m-1", { method: "PATCH", body: JSON.stringify({ displayName: "办公室 Mac" }) })).json() as any;
    expect(renamed.machine.display_name).toBe("办公室 Mac");
    expect(renamed.machine.name).toBe("A.local");

    ws.send(JSON.stringify({ type: "register", machineId: "m-1", windowId: "w-2", name: "A.local", os: "darwin", openWorkspaces: ["/ws/a"] }));
    await new Promise((r) => setTimeout(r, 80));
    const list = await (await api("/api/machines")).json() as any[];
    const m = list.find((x) => x.id === "m-1");
    expect(m.display_name).toBe("办公室 Mac");
    expect(m.name).toBe("A.local");
    ws.close();
  });
});
