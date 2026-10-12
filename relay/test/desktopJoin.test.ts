import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRelayServer, type RelayServer } from "../src/server";
import { openRelayDb } from "../src/db";
import { byteAssembler, byteFrames, decodeBody } from "../src/desktopFrames";
import { formatDesktopUri, parseRelayUri } from "../src/uri";

let srv: RelayServer | null = null;
const prevFail = process.env.ARMADA_DESKTOP_MIGRATE_FAIL;
afterEach(() => {
  srv?.stop();
  srv = null;
  if (prevFail == null) delete process.env.ARMADA_DESKTOP_MIGRATE_FAIL;
  else process.env.ARMADA_DESKTOP_MIGRATE_FAIL = prevFail;
});

function start(extra?: { home?: string; deskIdleMs?: number }) {
  const home = extra?.home ?? mkdtempSync(join(tmpdir(), "armada-desk-"));
  srv = createRelayServer({
    port: 0,
    hostname: "127.0.0.1",
    home,
    publicBase: "http://127.0.0.1:8780",
    adminToken: "adm-test",
    deskIdleMs: extra?.deskIdleMs,
  });
  return srv;
}

function connectHub(s: RelayServer, fleet: string, secret: string, onMsg: (msg: any, ws: WebSocket) => void): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/hub?fleet=${encodeURIComponent(fleet)}&secret=${encodeURIComponent(secret)}`);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error("hub ws failed"));
    ws.onmessage = (e) => onMsg(JSON.parse(String(e.data)), ws);
  });
}

function deskHeaders(token: string, fleet: string, extra?: Record<string, string>) {
  return { authorization: `Bearer ${token}`, "x-armada-fleet": fleet, ...(extra ?? {}) };
}

describe.serial("desktop invite", () => {
  test("parses armada-relay desktop and rejects it as a lan join", () => {
    const uri = formatDesktopUri("https://relay.example.com", "fleet-abc12", "a".repeat(64));
    expect(parseRelayUri(uri)).toEqual({
      kind: "desktop",
      relay: "https://relay.example.com",
      fleet: "fleet-abc12",
      token: "a".repeat(64),
    });
  });
});

describe.serial("desktop_token migration", () => {
  test("fills two existing fleets and ignores an index that already exists", () => {
    const home = mkdtempSync(join(tmpdir(), "armada-mig-"));
    const db = new Database(join(home, "relay.db"));
    db.exec(`CREATE TABLE fleets (
      id TEXT PRIMARY KEY,
      hub_secret TEXT NOT NULL UNIQUE,
      operator_token TEXT NOT NULL UNIQUE,
      hub_online INTEGER NOT NULL DEFAULT 0,
      workspaces TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )`);
    db.exec(`INSERT INTO fleets (id, hub_secret, operator_token, created_at) VALUES ('fleet-aaaa1111','${"a".repeat(64)}','${"b".repeat(64)}',1)`);
    db.exec(`INSERT INTO fleets (id, hub_secret, operator_token, created_at) VALUES ('fleet-bbbb2222','${"c".repeat(64)}','${"d".repeat(64)}',1)`);
    db.close();
    const opened = openRelayDb(home);
    const rows = opened.query("SELECT desktop_token FROM fleets ORDER BY id").all() as { desktop_token: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.desktop_token).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[1]!.desktop_token).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]!.desktop_token).not.toBe(rows[1]!.desktop_token);
    expect(opened.query("SELECT name FROM sqlite_master WHERE name='fleets_desktop_token_uq'").get()).toBeTruthy();
    opened.close();
    const again = openRelayDb(home);
    again.close();
  });

  test("a failed migration still serves /mobile/workspaces", async () => {
    process.env.ARMADA_DESKTOP_MIGRATE_FAIL = "1";
    const s = start();
    const fleet = s.createFleet();
    const res = await fetch(`http://127.0.0.1:${s.port}/mobile/workspaces`, {
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
    });
    expect(res.status).toBe(200);
    const desk = await fetch(`http://127.0.0.1:${s.port}/desktop/api/machines`, {
      headers: deskHeaders("e".repeat(64), fleet.fleet),
    });
    expect(desk.status).toBe(503);
  });
});

describe.serial("desktop gateway", () => {
  test("health stays on the relay and does not open a desk frame", async () => {
    const s = start();
    const fleet = s.createFleet();
    const seen: string[] = [];
    await connectHub(s, fleet.fleet, fleet.hubSecret, (msg) => { if (msg.type) seen.push(msg.type); });
    const res = await fetch(`http://127.0.0.1:${s.port}/desktop/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "armada-relay", protocolVersion: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.filter((t) => t.startsWith("desk."))).toEqual([]);
  });

  test("rejects missing, operator, and hub credentials", async () => {
    const s = start();
    const fleet = s.createFleet();
    await connectHub(s, fleet.fleet, fleet.hubSecret, () => {});
    const base = `http://127.0.0.1:${s.port}/desktop/ws`;
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { headers: deskHeaders(fleet.operatorToken, fleet.fleet) })).status).toBe(403);
    const secret = await fetch(base, { headers: deskHeaders(fleet.hubSecret, fleet.fleet) });
    expect(secret.status).toBe(403);
    expect(await secret.json()).toEqual({ error: "DESKTOP_REQUIRED" });
    const mismatch = await fetch(`http://127.0.0.1:${s.port}/desktop/api/machines`, {
      headers: deskHeaders(fleet.desktopToken!, "fleet-other1"),
    });
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toEqual({ error: "FLEET_MISMATCH" });
  });

  test("desktop token cannot call /mobile/workspaces", async () => {
    const s = start();
    const fleet = s.createFleet();
    const res = await fetch(`http://127.0.0.1:${s.port}/mobile/workspaces`, {
      headers: { authorization: `Bearer ${fleet.desktopToken}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "OPERATOR_REQUIRED" });
  });

  test("keeps query params other than token and reassembles a multi-frame body", async () => {
    const s = start({ deskIdleMs: 1000 });
    const fleet = s.createFleet();
    let seenPath = "";
    let seenBytes = 0;
    await connectHub(s, fleet.fleet, fleet.hubSecret, (msg, ws) => {
      if (msg.type !== "desk.http") return;
      const asm = (ws as any)._asm ?? byteAssembler();
      (ws as any)._asm = asm;
      const pushed = asm.push(msg.seq, msg.last === true, decodeBody(msg.bodyBase64));
      if (!pushed.ok || !pushed.done) return;
      seenPath = msg.path;
      seenBytes = pushed.value.length;
      const frames = byteFrames(pushed.value);
      for (const frame of frames) {
        ws.send(JSON.stringify({
          type: "desk.http.result",
          streamId: msg.streamId,
          status: 200,
          headers: { "content-type": "application/octet-stream" },
          ...frame,
        }));
      }
    });
    const payload = new Uint8Array(70 * 1024);
    payload[0] = 7;
    payload[payload.length - 1] = 9;
    const res = await fetch(
      `http://127.0.0.1:${s.port}/desktop/api/runs?archived=1&limit=5&fromEnd=1&path=docs%2Fa.md&token=leak&desktop=1`,
      { method: "POST", headers: deskHeaders(fleet.desktopToken!, fleet.fleet), body: payload },
    );
    expect(res.status).toBe(200);
    const back = new Uint8Array(await res.arrayBuffer());
    expect(back.length).toBe(payload.length);
    expect(back[0]).toBe(7);
    expect(back[back.length - 1]).toBe(9);
    expect(seenBytes).toBe(payload.length);
    expect(seenPath).toBe("/api/runs?archived=1&limit=5&fromEnd=1&path=docs%2Fa.md");
    expect(seenPath).not.toContain("token");
    expect(seenPath).not.toContain("desktop");
  });

  test("an open sse does not block a phone command", async () => {
    const s = start({ deskIdleMs: 40 });
    const fleet = s.createFleet();
    await connectHub(s, fleet.fleet, fleet.hubSecret, (msg, ws) => {
      if (msg.type === "desk.stream.open") {
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "desk.stream.chunk", streamId: msg.streamId, seq: 0, data: ":ok\n\n" }));
        }, 80);
      }
      if (msg.type === "cmd.promptSnippetsGet") {
        ws.send(JSON.stringify({ type: "cmd.result", requestId: msg.requestId, ok: true, snippets: [] }));
      }
    });
    const sse = await fetch(`http://127.0.0.1:${s.port}/desktop/api/events`, {
      headers: deskHeaders(fleet.desktopToken!, fleet.fleet),
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const snippets = await fetch(`http://127.0.0.1:${s.port}/mobile/prompt-snippets`, {
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
    });
    expect(snippets.status).toBe(200);
    const reader = sse.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe(":ok\n\n");
    reader.releaseLock();
  });

  test("a held upload does not block dispatch", async () => {
    const s = start({ deskIdleMs: 2000 });
    const fleet = s.createFleet();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    await connectHub(s, fleet.fleet, fleet.hubSecret, (msg, ws) => {
      if (msg.type === "cmd.promptSnippetsGet") {
        ws.send(JSON.stringify({ type: "cmd.result", requestId: msg.requestId, ok: true, snippets: [] }));
      }
      if (msg.type === "desk.http" && msg.last === true) {
        void held.then(() => {
          ws.send(JSON.stringify({
            type: "desk.http.result",
            streamId: msg.streamId,
            seq: 0,
            last: true,
            status: 201,
            headers: { "content-type": "application/json" },
            bodyBase64: Buffer.from("{}").toString("base64"),
          }));
        });
      }
    });
    const upload = fetch(`http://127.0.0.1:${s.port}/desktop/api/blobs`, {
      method: "POST",
      headers: deskHeaders(fleet.desktopToken!, fleet.fleet, { "content-type": "multipart/form-data; boundary=b" }),
      body: "x".repeat(80 * 1024),
    });
    const snippets = await fetch(`http://127.0.0.1:${s.port}/mobile/prompt-snippets`, {
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
    });
    expect(snippets.status).toBe(200);
    release();
    expect((await upload).status).toBe(201);
  });

  test("forwards close codes and ignores unknown desk frames", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-desk-audit-"));
    const s = start({ home });
    const fleet = s.createFleet();
    await connectHub(s, fleet.fleet, fleet.hubSecret, (msg, ws) => {
      if (msg.type === "desk.ws.open") {
        ws.send(JSON.stringify({ type: "desk.nope", streamId: msg.streamId }));
        ws.send(JSON.stringify({ type: "desk.ws.close", streamId: msg.streamId, code: 4001, reason: "register" }));
      }
      if (msg.type === "cmd.promptSnippetsGet") {
        ws.send(JSON.stringify({ type: "cmd.result", requestId: msg.requestId, ok: true, snippets: [] }));
      }
    });
    const closed = new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/desktop/ws`, {
        headers: deskHeaders(fleet.desktopToken!, fleet.fleet),
      } as any);
      ws.onclose = (ev) => resolve(ev.code);
      ws.onerror = () => reject(new Error("desktop ws failed"));
    });
    expect(await closed).toBe(4001);
    const snippets = await fetch(`http://127.0.0.1:${s.port}/mobile/prompt-snippets`, {
      headers: { authorization: `Bearer ${fleet.operatorToken}` },
    });
    expect(snippets.status).toBe(200);
    const db = new Database(join(home, "relay.db"), { readonly: true });
    const rows = db.query("SELECT action, payload FROM audit WHERE actor='desktop'").all() as { action: string; payload: string }[];
    db.close();
    expect(rows.some((r) => r.action === "join.open")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("machineId");
  });
});
