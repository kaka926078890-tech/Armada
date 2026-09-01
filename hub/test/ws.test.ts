import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-ws-"));
  hub = createServer({ port: 0, home });
  return hub;
}

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))), { once: true });
  });
}

const REG = {
  type: "register", machineId: "m-1", windowId: "w-1", name: "Mac-A",
  os: "darwin-arm64", cursorVersion: "1.7.38", extensionVersion: "0.1.0",
  openWorkspaces: ["/ws/a"],
};

describe("WS registry", () => {
  test("rejects wrong token at upgrade", async () => {
    const h = start();
    await expect(connect(h.port, "wrong")).rejects.toThrow();
  });

  test("register → registered, machine online in db", async () => {
    const h = start();
    const ws = await connect(h.port, h.token);
    const p = nextMessage(ws);
    ws.send(JSON.stringify(REG));
    const msg = await p;
    expect(msg).toEqual({ type: "registered", machineId: "m-1" });
    const m = h.registry.getMachine("m-1")!;
    expect(m.status).toBe("online");
    expect(JSON.parse(m.open_workspaces)).toEqual(["/ws/a"]);
    ws.close();
  });

  test("heartbeat updates open_workspaces", async () => {
    const h = start();
    const ws = await connect(h.port, h.token);
    const p = nextMessage(ws);
    ws.send(JSON.stringify(REG));
    await p;
    ws.send(JSON.stringify({ type: "heartbeat", openWorkspaces: ["/ws/a", "/ws/b"], activeRunIds: [] }));
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.parse(h.registry.getMachine("m-1")!.open_workspaces)).toEqual(["/ws/a", "/ws/b"]);
    ws.close();
  });

  test("same connKey reconnect kicks old connection", async () => {
    const h = start();
    const ws1 = await connect(h.port, h.token);
    let p = nextMessage(ws1);
    ws1.send(JSON.stringify(REG));
    await p;
    const ws2 = await connect(h.port, h.token);
    p = nextMessage(ws2);
    ws2.send(JSON.stringify(REG));
    await p;
    await new Promise((r) => setTimeout(r, 100));
    expect(ws1.readyState).toBe(WebSocket.CLOSED);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    ws2.close();
  });

  test("sweep marks stale machine offline", async () => {
    const h = start();
    const ws = await connect(h.port, h.token);
    const p = nextMessage(ws);
    ws.send(JSON.stringify(REG));
    await p;
    h.db.query("UPDATE machines SET last_seen_at=?1 WHERE id='m-1'").run(Date.now() - 60_000);
    h.registry.sweep();
    expect(h.registry.getMachine("m-1")!.status).toBe("offline");
    ws.close();
  });

  test("findWindowForWorkspace matches openWorkspaces", async () => {
    const h = start();
    const ws = await connect(h.port, h.token);
    const p = nextMessage(ws);
    ws.send(JSON.stringify(REG));
    await p;
    expect(h.registry.findWindowForWorkspace("m-1", "/ws/a")).toEqual({ machineId: "m-1", windowId: "w-1" });
    expect(h.registry.findWindowForWorkspace("m-1", "/nope")).toBeNull();
    ws.close();
  });

  test("multi-window same machine: routing is per-connection, not machine-level", async () => {
    const h = start();
    const ws1 = await connect(h.port, h.token);
    let p = nextMessage(ws1);
    ws1.send(JSON.stringify(REG)); // w-1: ["/ws/a"]
    await p;
    const ws2 = await connect(h.port, h.token);
    p = nextMessage(ws2);
    ws2.send(JSON.stringify({ ...REG, windowId: "w-2", openWorkspaces: ["/ws/b"] }));
    await p;
    // 每个工作区路由到真正开着它的窗口,与注册顺序无关
    expect(h.registry.findWindowForWorkspace("m-1", "/ws/a")).toEqual({ machineId: "m-1", windowId: "w-1" });
    expect(h.registry.findWindowForWorkspace("m-1", "/ws/b")).toEqual({ machineId: "m-1", windowId: "w-2" });
    // 机器级展示为并集
    expect(JSON.parse(h.registry.getMachine("m-1")!.open_workspaces).sort()).toEqual(["/ws/a", "/ws/b"]);
    // w-2 心跳改工作区后路由跟随
    ws2.send(JSON.stringify({ type: "heartbeat", openWorkspaces: ["/ws/c"], activeRunIds: [] }));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.registry.findWindowForWorkspace("m-1", "/ws/c")).toEqual({ machineId: "m-1", windowId: "w-2" });
    expect(h.registry.findWindowForWorkspace("m-1", "/ws/b")).toBeNull();
    expect(h.registry.findWindowForWorkspace("m-1", "/ws/a")).toEqual({ machineId: "m-1", windowId: "w-1" });
    ws1.close();
    ws2.close();
  });

  test("register pushes machine.updated on the board SSE stream", async () => {
    const h = start();
    const res = await fetch(`http://127.0.0.1:${h.port}/api/events?token=${h.token}`);
    expect(res.ok).toBe(true);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const sawUpdated = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return false;
        buf += dec.decode(value, { stream: true });
        if (buf.includes("machine.updated")) return true;
      }
    })();
    const ws = await connect(h.port, h.token);
    const p = nextMessage(ws);
    ws.send(JSON.stringify(REG));
    await p;
    const found = await Promise.race([
      sawUpdated,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    await reader.cancel().catch(() => {});
    ws.close();
    expect(found).toBe(true);
  });
});
