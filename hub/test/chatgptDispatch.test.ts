import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { attachChatgpt } from "../src/chatgptAttach";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-chatgpt-dispatch-"));
  hub = createServer({ port: 0, home });
  hub.db.query(
    "INSERT INTO machines (id, name, os, open_workspaces, status) VALUES ('m-1','Mac','darwin','[]','online')",
  ).run();
  hub.runs.setChatgptRoots(["chatgpt:", "chatgpt:desk"]);
  const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${hub!.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}`, ...(init?.headers ?? {}) },
  });
  return { api };
}

describe("chatgpt dispatch", () => {
  test("creates a run without a Cursor window or conversation id", async () => {
    const { api } = start();
    const res = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "chatgpt:desk", prompt: "只回复 armada-hub-ok" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { run: { status: string; conversation_id: string | null; window_id: string | null; workspace_root: string } };
    expect(body.run.status).toBe("dispatched");
    expect(body.run.conversation_id).toBeNull();
    expect(body.run.window_id).toBeNull();
    expect(body.run.workspace_root).toBe("chatgpt:desk");
  });

  test("a second send waits until the first user line is bound", async () => {
    const { api } = start();
    await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "chatgpt:", prompt: "第一句" }),
    });
    const second = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "chatgpt:desk", prompt: "第二句" }),
    });
    const body = await second.json() as { run: { status: string } };
    expect(body.run.status).toBe("queued");
  });

  test("the user line moves a dispatched card to running", () => {
    start();
    hub!.db.query(
      `INSERT INTO runs (id, machine_id, workspace_root, prompt, status, created_at)
       VALUES ('r-1','m-1','chatgpt:desk','只回复 armada-hub-ok','dispatched',?1)`,
    ).run(Date.now());
    hub!.runs.noteChatgptRollout("r-1", JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "thread-1",
        turn_id: "turn-1",
        item: { type: "UserMessage", content: [{ type: "text", text: "只回复 armada-hub-ok\n" }] },
      },
    }));
    const run = hub!.runs.get("r-1");
    expect(run.status).toBe("running");
    expect(run.chatgpt_thread_id).toBe("thread-1");
    expect(run.conversation_id).toBeNull();
  });
});

describe("attachChatgpt", () => {
  test("the column hangs on the online local Mac, not Windows", () => {
    const rows = attachChatgpt([
      { id: "win", name: "PF39WTSM", os: "win32-x64", status: "online" },
      { id: "mac", name: "appledeMacBook-Pro.local", os: "darwin-arm64", status: "online" },
      { id: "old", name: "appledeMacBook-Pro.local", os: "darwin-arm64", status: "offline" },
    ], { port: "ready", targets: [{ root: "chatgpt:", label: "普通区" }] }, "appledeMacBook-Pro.local");
    const mac = rows.find((row) => row.id === "mac");
    const win = rows.find((row) => row.id === "win");
    expect(mac?.chatgpt_workspaces).toEqual([{ root: "chatgpt:", label: "普通区", ready: true }]);
    expect(win?.chatgpt_workspaces).toBeUndefined();
  });

  test("a down debug port is a monitor row, not a dispatch target", () => {
    const rows = attachChatgpt([
      { id: "mac", name: "appledeMacBook-Pro.local", os: "darwin-arm64", status: "online" },
    ], { port: "down", targets: [] }, "appledeMacBook-Pro.local");
    expect(rows[0].chatgpt_workspaces).toEqual([
      { root: "chatgpt:monitor", label: "需要用监控启动", ready: false },
    ]);
  });
});
