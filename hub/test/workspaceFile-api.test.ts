import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { FILE_VIEW_MIN_EXT } from "../../extension/src/workspaceFile";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

async function startWithExt(opts: { extensionVersion?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "armada-wsfile-api-"));
  hub = createServer({ port: 0, home, fileReadTimeoutMs: 80 });
  const ws: WebSocket = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const inbound: any[] = [];
  ws.addEventListener("message", (e) => inbound.push(JSON.parse(String(e.data))));
  ws.send(JSON.stringify({
    type: "register", machineId: "m-1", windowId: "w-1", name: "Mac-A",
    os: "darwin-arm64", openWorkspaces: ["/ws/a"],
    extensionVersion: opts.extensionVersion ?? FILE_VIEW_MIN_EXT,
    cdpReady: true,
  }));
  await new Promise((r) => setTimeout(r, 80));
  inbound.length = 0;
  const api = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${hub!.port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}`, ...(init?.headers ?? {}) },
    });
  return { ws, inbound, api };
}

describe("GET /api/runs/:id/file", () => {
  test("reads text from the agent and rejects missing run", async () => {
    const { ws, inbound, api } = await startWithExt();
    const created = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hi" }),
    });
    const { run } = await created.json() as any;
    const pending = api(`/api/runs/${run.id}/file?path=${encodeURIComponent("docs/spec.md")}`);
    await new Promise((r) => setTimeout(r, 40));
    const req = inbound.find((m) => m.type === "workspace.readFile");
    expect(req).toMatchObject({ type: "workspace.readFile", workspaceRoot: "/ws/a", path: "docs/spec.md" });
    ws.send(JSON.stringify({
      type: "workspace.file", requestId: req.requestId, ok: true,
      path: "/ws/a/docs/spec.md", name: "spec.md", mime: "text/markdown", text: "# hi\n",
    }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      path: "/ws/a/docs/spec.md", name: "spec.md", mime: "text/markdown", text: "# hi\n",
    });
    expect((await api("/api/runs/nope/file?path=a.md")).status).toBe(404);
  });

  test("old extension is FILE_VIEW_UNSUPPORTED without waiting", async () => {
    const { inbound, api } = await startWithExt({ extensionVersion: "0.4.43" });
    const created = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hi" }),
    });
    const { run } = await created.json() as any;
    const r = await api(`/api/runs/${run.id}/file?path=docs/spec.md`);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "FILE_VIEW_UNSUPPORTED" });
    expect(inbound.some((m) => m.type === "workspace.readFile")).toBe(false);
  });

  test("agent timeout is FILE_READ_TIMEOUT", async () => {
    const { api } = await startWithExt();
    const created = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ machineId: "m-1", workspaceRoot: "/ws/a", prompt: "hi" }),
    });
    const { run } = await created.json() as any;
    const r = await api(`/api/runs/${run.id}/file?path=docs/spec.md`);
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "FILE_READ_TIMEOUT" });
  });
});
