import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { loadRelayConfig, runToSnap } from "../src/relayClient";
import { createRelayServer, type RelayServer } from "../../relay/src/server";
import { encodeWorkspaceId } from "../../relay/src/uri";
import type { RunEvent } from "../web/src/types";

let hub: HubServer | null = null;
let relay: RelayServer | null = null;
afterEach(() => {
  hub?.stop(); hub = null;
  relay?.stop(); relay = null;
});

function ev(partial: Partial<RunEvent> & { seq: number; payload: string }): RunEvent {
  return {
    id: partial.seq, run_id: "r-1", source: "hook", hook_event_name: null,
    ts: 0, post_terminal: 0, ...partial,
  };
}

async function waitUntil(fn: () => Promise<boolean> | boolean, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await Bun.sleep(40);
  }
  throw new Error("timeout");
}

describe("loadRelayConfig", () => {
  test("returns null when missing or invalid", () => {
    const home = mkdtempSync(join(tmpdir(), "armada-relaycfg-"));
    expect(loadRelayConfig(home)).toBeNull();
    writeFileSync(join(home, "relay.json"), "{");
    expect(loadRelayConfig(home)).toBeNull();
    writeFileSync(join(home, "relay.json"), JSON.stringify({
      relay: "http://evil.example", fleet: "fleet-abc12", secret: "a".repeat(64),
    }));
    expect(loadRelayConfig(home)).toBeNull();
  });

  test("loads loopback http pair fields", () => {
    const home = mkdtempSync(join(tmpdir(), "armada-relaycfg-"));
    writeFileSync(join(home, "relay.json"), JSON.stringify({
      relay: "http://127.0.0.1:8780", fleet: "fleet-abc12", secret: "a".repeat(64),
    }));
    expect(loadRelayConfig(home)).toEqual({
      relay: "http://127.0.0.1:8780", fleet: "fleet-abc12", secret: "a".repeat(64),
    });
  });
});

describe("runToSnap", () => {
  test("completed requires assistantBodyText", () => {
    const run = { id: "r-1", machine_id: "m-1", workspace_root: "/ws/a", prompt: "hi", status: "completed", created_at: 1 };
    expect(runToSnap(run, []).status).toBe("error");
    expect(runToSnap(run, []).error).toBe("NO_ASSISTANT_BODY");
    const events = [ev({
      seq: 1, source: "transcript",
      payload: JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "全文正文" }] } }),
    })];
    const snap = runToSnap(run, events);
    expect(snap.status).toBe("completed");
    expect(snap.finalText).toBe("全文正文");
  });
});

describe("hub outbound to relay", () => {
  test("lists open workspaces and dispatches via loopback /api/runs", async () => {
    const relayHome = mkdtempSync(join(tmpdir(), "armada-relay-"));
    const hubHome = mkdtempSync(join(tmpdir(), "armada-hub-"));
    relay = createRelayServer({
      port: 0, hostname: "127.0.0.1", home: relayHome,
      publicBase: "http://127.0.0.1", adminToken: "adm",
    });
    const fleet = relay.createFleet();
    writeFileSync(join(hubHome, "relay.json"), JSON.stringify({
      relay: `http://127.0.0.1:${relay.port}`, fleet: fleet.fleet, secret: fleet.hubSecret,
    }), { mode: 0o600 });

    hub = createServer({ port: 0, home: hubHome });
    const ext: WebSocket = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w);
      w.onerror = rej;
    });
    ext.send(JSON.stringify({
      type: "register", machineId: "m-1", windowId: "w-1", name: "A", os: "darwin", openWorkspaces: ["/ws/a"],
    }));

    const headers = { authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
    await waitUntil(async () => {
      const j = await (await fetch(`http://127.0.0.1:${relay!.port}/mobile/workspaces`, { headers })).json() as any;
      return j.hubOffline === false && j.workspaces?.[0]?.workspaceRoot === "/ws/a";
    });

    const d = await fetch(`http://127.0.0.1:${relay.port}/mobile/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: encodeWorkspaceId("m-1", "/ws/a"), prompt: "from phone" }),
    });
    expect(d.status).toBe(201);
    const body = await d.json() as any;
    expect(body.run.prompt).toBe("from phone");
    expect(["queued", "dispatched", "binding", "running"]).toContain(body.run.status);
    const local = hub.runs.get(body.run.runId);
    expect(local.prompt).toBe("from phone");
    ext.close();
  });
});
