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
    expect(runToSnap(run, []).canRetry).toBe(true);
    const events = [ev({
      seq: 1, source: "transcript",
      payload: JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "全文正文" }] } }),
    })];
    const snap = runToSnap(run, events);
    expect(snap.status).toBe("completed");
    expect(snap.finalText).toBe("全文正文");
    expect(snap.canRetry).toBe(false);
  });

  test("completed finalText is the matching turn, not the whole thread", () => {
    const run = {
      id: "r-1", machine_id: "m-1", workspace_root: "/ws/a",
      prompt: "那时还没修好？", status: "completed", created_at: 1,
    };
    const events = [
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n更早的任务\n</user_query>" }] },
      }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "那是旧回复，很长……" }] },
      }) }),
      ev({ seq: 3, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n那时还没修好？\n</user_query>" }] },
      }) }),
      ev({ seq: 4, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "现在修好了。" }] },
      }) }),
    ];
    const snap = runToSnap(run, events);
    expect(snap.status).toBe("completed");
    expect(snap.finalText).toBe("现在修好了。");
  });

  test("running snap carries visible outbound and queue mode", () => {
    const run = {
      id: "r-1", machine_id: "m-1", workspace_root: "/ws/a", prompt: "hi", status: "running",
      outbound: [{ id: "o1", prompt: "排队", expected_mode: "queue", state: "queued", created_at: 1 }],
      queue_message_default_behavior: "queue",
    };
    const snap = runToSnap(run, []);
    expect(snap.status).toBe("running");
    expect(snap.outbound).toEqual([
      { id: "o1", prompt: "排队", expectedMode: "queue", state: "queued", createdAt: 1 },
    ]);
    expect(snap.queueMessageDefaultBehavior).toBe("queue");
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

  test("mobile followup on running run is 201 and snap shows outbound", async () => {
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
      type: "register", machineId: "m-1", windowId: "w-1", name: "A", os: "darwin",
      extensionVersion: "0.4.0", openWorkspaces: ["/ws/a"],
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
    const body = await d.json() as any;
    const runId = body.run.runId as string;
    ext.send(JSON.stringify({ type: "run.ack", runId, status: "accepted" }));
    ext.send(JSON.stringify({
      type: "run.bound", runId, conversationId: "cid-1", transcriptPath: null, promptMatch: true,
    }));
    await waitUntil(() => hub!.runs.get(runId)?.status === "running");

    const f = await fetch(`http://127.0.0.1:${relay.port}/mobile/runs/${runId}/followup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "续" }),
    });
    expect(f.status).toBe(201);
    const followed = await f.json() as any;
    expect(followed.run.status).toBe("running");
    expect(followed.run.outbound?.[0]).toMatchObject({ prompt: "续", state: "injecting" });

    const got = await (await fetch(`http://127.0.0.1:${relay.port}/mobile/runs/${runId}`, { headers })).json() as any;
    expect(got.outbound?.[0]).toMatchObject({ prompt: "续", state: "injecting" });
    ext.close();
  });
});
