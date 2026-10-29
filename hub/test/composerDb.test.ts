import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import {
  composerFeedWatches, cursorFromEmitted, emptyCursor, matchComposer, planComposerTick, readComposerView, readHeaderCandidates,
  type ComposerBubble, type ComposerView,
} from "../src/composerDb";
import { createServer, type HubServer } from "../src/index";

function bubble(partial: Partial<ComposerBubble> & { id: string }): ComposerBubble {
  return {
    type: 2, text: "", thinking: "", toolName: "", toolStatus: "", subagentComposerId: "", requestId: "",
    ...partial,
  };
}

const CURSOR_GEN = "6bc4f02c-7ae3-4e80-a2b3-b8f613605ee7";

function stoppedAfterFirstTurn() {
  return cursorFromEmitted([
    { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "first", bubble_id: "u1", generation_id: "gen-1", conversation_id: "cid-1" } },
    { source: "db", hook: "afterAgentResponse", payload: { text: "done once", bubble_id: "a1", generation_id: "gen-1", conversation_id: "cid-1" } },
    { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-1", conversation_id: "cid-1" } },
  ]);
}

function snap(partial: Partial<ComposerView> & { cid: string }): ComposerView {
  return { status: "aborted", generationId: "gen-1", subagentIds: [], bubbles: [], ...partial };
}

describe("composer table plan", () => {
  test("a live turn keeps chatGenerationUUID and does not stop while status stays aborted", () => {
    const view = snap({
      cid: "cid-1",
      bubbles: [
        bubble({ id: "u", type: 1, text: "do the thing" }),
        bubble({ id: "t", thinking: "looking" }),
        bubble({ id: "tool", toolName: "Shell", toolStatus: "loading", toolInput: { command: "sleep 1" } }),
      ],
    });
    const { events, cursor } = planComposerTick(view, [], emptyCursor());
    expect(events.map((e) => e.hook)).toEqual(["beforeSubmitPrompt", "afterAgentThought", "preToolUse"]);
    expect(events.find((e) => e.hook === "stop")).toBeUndefined();
    expect(cursor.generationId).toBe("gen-1");
    expect(cursor.stopped).toBe(false);
  });

  test("clearing the uuid with status completed emits the assistant text and stop for that generation", () => {
    const live = snap({
      cid: "cid-1",
      bubbles: [bubble({ id: "u", type: 1, text: "do the thing" })],
    });
    const armed = planComposerTick(live, [], emptyCursor()).cursor;
    const done = snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        bubble({ id: "u", type: 1, text: "do the thing" }),
        bubble({ id: "a", type: 2, text: "finished" }),
      ],
    });
    const { events } = planComposerTick(done, [], armed);
    const stop = events.find((e) => e.hook === "stop");
    expect(stop?.payload.status).toBe("completed");
    expect(stop?.payload.generation_id).toBe("gen-1");
    expect(events.some((e) => e.hook === "afterAgentResponse" && e.payload.text === "finished")).toBe(true);
  });

  test("a recovered turn flushes its text and stops the old generation before the next user", () => {
    const armed = planComposerTick(snap({
      cid: "cid-1",
      bubbles: [bubble({ id: "u1", type: 1, text: "first" })],
    }), [], emptyCursor()).cursor;
    const next = snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-2",
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first" }),
        bubble({ id: "a", type: 2, text: "the real body" }),
        bubble({ id: "u2", type: 1, text: "second" }),
      ],
    });
    const { events } = planComposerTick(next, [], armed);
    const bodyAt = events.findIndex((e) => e.hook === "afterAgentResponse" && e.payload.text === "the real body");
    const stopAt = events.findIndex((e) => e.hook === "stop");
    const secondAt = events.findIndex((e) => e.hook === "beforeSubmitPrompt" && e.payload.prompt === "second");
    expect(bodyAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(bodyAt);
    expect(secondAt).toBeGreaterThan(stopAt);
    expect(events[stopAt]?.payload).toMatchObject({ status: "completed", generation_id: "gen-1" });
  });

  test("uuid already swapped after the next user was emitted still flushes the previous body", () => {
    const armed = planComposerTick(snap({
      cid: "cid-1",
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first" }),
        bubble({ id: "a", type: 2, text: "the real body" }),
        bubble({ id: "u2", type: 1, text: "second" }),
      ],
    }), [], emptyCursor()).cursor;
    expect(armed.users).toEqual(["u1", "u2"]);
    expect(armed.stopped).toBe(false);
    const swapped = snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-2",
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first" }),
        bubble({ id: "a", type: 2, text: "the real body" }),
        bubble({ id: "u2", type: 1, text: "second" }),
      ],
    });
    const { events } = planComposerTick(swapped, [], armed);
    const bodyAt = events.findIndex((e) => e.hook === "afterAgentResponse" && e.payload.text === "the real body");
    const stopAt = events.findIndex((e) => e.hook === "stop");
    expect(bodyAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(bodyAt);
    expect(events[stopAt]?.payload).toMatchObject({ status: "completed", generation_id: "gen-1" });
  });

  test("a new generation without a new user bubble does not stop the open turn", () => {
    const armed = planComposerTick(snap({
      cid: "cid-1",
      generationId: "gen-1",
      bubbles: [
        bubble({ id: "u", type: 1, text: "do the thing" }),
        bubble({ id: "a", type: 2, text: "partial" }),
      ],
    }), [], emptyCursor()).cursor;
    const { events } = planComposerTick(snap({
      cid: "cid-1",
      generationId: "gen-2",
      bubbles: [
        bubble({ id: "u", type: 1, text: "do the thing" }),
        bubble({ id: "a", type: 2, text: "partial" }),
      ],
    }), [], armed);
    expect(events.some((e) => e.hook === "stop")).toBe(false);
    expect(events.some((e) => e.hook === "afterAgentResponse")).toBe(false);
  });

  test("one aborted sample after the uuid clears does not stop; completed on the next sample does", () => {
    const armed = planComposerTick(snap({ cid: "cid-1", bubbles: [bubble({ id: "u", type: 1, text: "hi" })] }), [], emptyCursor()).cursor;
    const cleared = snap({ cid: "cid-1", status: "aborted", generationId: null, bubbles: [bubble({ id: "u", type: 1, text: "hi" })] });
    const hold = planComposerTick(cleared, [], armed);
    expect(hold.events.some((e) => e.hook === "stop")).toBe(false);
    const done = planComposerTick({ ...cleared, status: "completed" }, [], hold.cursor);
    expect(done.events.find((e) => e.hook === "stop")?.payload.status).toBe("completed");
  });

  test("parent stop waits while the child still has its own uuid", () => {
    const parent = snap({
      cid: "parent",
      status: "completed",
      generationId: null,
      subagentIds: ["child"],
      bubbles: [
        bubble({ id: "u", type: 1, text: "go" }),
        bubble({ id: "task", toolName: "task_v2", toolStatus: "loading", subagentComposerId: "child", toolInput: { description: "write" } }),
      ],
    });
    const child = snap({
      cid: "child",
      generationId: "child-gen",
      bubbles: [bubble({ id: "c", type: 2, text: "working" })],
    });
    const armed = planComposerTick(snap({ cid: "parent", bubbles: [bubble({ id: "u", type: 1, text: "go" })] }), [], emptyCursor()).cursor;
    const { events } = planComposerTick(parent, [child], armed);
    expect(events.some((e) => e.hook === "stop")).toBe(false);
    expect(events.some((e) => e.hook === "subagentStart")).toBe(true);
    expect(events.some((e) => e.source === "subagent-transcript" && e.payload.role === "assistant")).toBe(true);
  });

  // r-2aadbcbc: overlay restarted the hub after a follow-up armed gen-live.
  // Replay saw the previous stop first, so uuid-cleared never emitted this turn's text or stop.
  test("a rebuilt cursor drops the previous stop once a later submit arms a new generation", () => {
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "first", bubble_id: "u1", generation_id: "gen-old", conversation_id: "cid-1" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "done once", bubble_id: "a1", generation_id: "gen-old", conversation_id: "cid-1" } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-old", conversation_id: "cid-1" } },
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "????????", conversation_id: "cid-1" } },
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "????????", bubble_id: "u2", generation_id: "gen-live", conversation_id: "cid-1" } },
      { source: "db", hook: "preToolUse", payload: { tool_name: "Shell", conversation_id: "cid-1", bubble_id: "tool1" } },
    ]);
    expect(cursor.stopped).toBe(false);
    expect(cursor.armedGen).toBe("gen-live");
    const done = snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first" }),
        bubble({ id: "a1", type: 2, text: "done once" }),
        bubble({ id: "u2", type: 1, text: "????????" }),
        bubble({ id: "tool1", toolName: "Shell", toolStatus: "completed" }),
        bubble({ id: "final", type: 2, text: "Armada ????????" }),
      ],
    });
    const { events } = planComposerTick(done, [], cursor);
    expect(events.find((e) => e.hook === "stop")?.payload).toMatchObject({ status: "completed", generation_id: "gen-live" });
    expect(events.some((e) => e.hook === "afterAgentResponse" && e.payload.text === "Armada ????????")).toBe(true);
    expect(events.some((e) => e.payload.text === "done once")).toBe(false);
  });

  test("a rebuilt cursor stays stopped when the latest submit is the generation that already stopped", () => {
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "first", bubble_id: "u1", generation_id: "gen-1" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "done", bubble_id: "a1", generation_id: "gen-1" } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-1" } },
    ]);
    expect(cursor.stopped).toBe(true);
    const { events } = planComposerTick(snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first" }),
        bubble({ id: "a1", type: 2, text: "done" }),
      ],
    }), [], cursor);
    expect(events.some((e) => e.hook === "stop")).toBe(false);
  });

  // r-2209d0b5: card already stopped. Operator typed in Cursor. The feed next saw the
  // finished turn only after an Armada follow-up. User requestId is the generation;
  // chatGenerationUUID was already gone, so the body was skipped and only the prompt landed.
  test("a stopped card emits a finished Cursor turn's prompt, body, and stop", () => {
    const cursor = stoppedAfterFirstTurn();
    expect(cursor.stopped).toBe(true);
    const done = snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first", requestId: "gen-1" }),
        bubble({ id: "a1", type: 2, text: "done once" }),
        bubble({ id: "u2", type: 1, text: "?????????", requestId: CURSOR_GEN }),
        bubble({ id: "a2", type: 2, text: "?????????? SynLoom???????????????" }),
      ],
    });
    const { events } = planComposerTick(done, [], cursor);
    const userAt = events.findIndex((e) => e.hook === "beforeSubmitPrompt" && e.payload.prompt === "?????????");
    const bodyAt = events.findIndex((e) => e.hook === "afterAgentResponse" && e.payload.text === "?????????? SynLoom???????????????");
    const stopAt = events.findIndex((e) => e.hook === "stop" && e.payload.generation_id === CURSOR_GEN);
    expect(userAt).toBeGreaterThanOrEqual(0);
    expect(events[userAt]?.payload.generation_id).toBe(CURSOR_GEN);
    expect(bodyAt).toBeGreaterThan(userAt);
    expect(stopAt).toBeGreaterThan(bodyAt);
    expect(events[stopAt]?.payload.status).toBe("completed");
    expect(events.some((e) => e.payload.text === "done once")).toBe(false);
  });

  test("a finished Cursor turn closes before the live follow-up that woke the feed", () => {
    const cursor = stoppedAfterFirstTurn();
    const liveGen = "f05540d0-5537-41d7-940f-bc6fabea1809";
    const { events } = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: liveGen,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first", requestId: "gen-1" }),
        bubble({ id: "a1", type: 2, text: "done once" }),
        bubble({ id: "u2", type: 1, text: "?????????", requestId: CURSOR_GEN }),
        bubble({ id: "a2", type: 2, text: "?????????? SynLoom???????????????" }),
        bubble({ id: "u3", type: 1, text: "???????????????????", requestId: liveGen }),
      ],
    }), [], cursor);
    const userAt = events.findIndex((e) => e.hook === "beforeSubmitPrompt" && e.payload.prompt === "?????????");
    const bodyAt = events.findIndex((e) => e.hook === "afterAgentResponse" && String(e.payload.text).includes("?????"));
    const stopAt = events.findIndex((e) => e.hook === "stop" && e.payload.generation_id === CURSOR_GEN);
    const liveAt = events.findIndex((e) => e.hook === "beforeSubmitPrompt" && e.payload.prompt === "???????????????????");
    expect(userAt).toBeGreaterThanOrEqual(0);
    expect(bodyAt).toBeGreaterThan(userAt);
    expect(stopAt).toBeGreaterThan(bodyAt);
    expect(liveAt).toBeGreaterThan(stopAt);
    expect(events[liveAt]?.payload.generation_id).toBe(liveGen);
    expect(events.some((e) => e.hook === "stop" && e.payload.generation_id === liveGen)).toBe(false);
  });

  test("a Cursor turn that still holds chatGenerationUUID is armed and not stopped", () => {
    const cursor = stoppedAfterFirstTurn();
    const { events } = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: CURSOR_GEN,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first", requestId: "gen-1" }),
        bubble({ id: "a1", type: 2, text: "done once" }),
        bubble({ id: "u2", type: 1, text: "?????????", requestId: CURSOR_GEN }),
      ],
    }), [], cursor);
    expect(events.find((e) => e.hook === "beforeSubmitPrompt" && e.payload.prompt === "?????????")?.payload.generation_id).toBe(CURSOR_GEN);
    expect(events.some((e) => e.hook === "stop")).toBe(false);
  });

  test("a rebuilt cursor keeps the new generation's own stop", () => {
    const cursor = cursorFromEmitted([
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-old" } },
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "again", bubble_id: "u2", generation_id: "gen-live" } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-live" } },
    ]);
    expect(cursor.stopped).toBe(true);
    expect(cursor.armedGen).toBe("gen-live");
  });
});

describe("composer feed watch", () => {
  test("a bound terminal card stays on the table feed; a closed card does not", () => {
    expect(composerFeedWatches({ status: "running", conversation_id: "cid" })).toBe(true);
    expect(composerFeedWatches({ status: "completed", conversation_id: "cid", end_reason: "completed" })).toBe(true);
    expect(composerFeedWatches({ status: "cancelled", conversation_id: "cid", end_reason: "cancelled" })).toBe(true);
    expect(composerFeedWatches({ status: "completed", conversation_id: "cid", end_reason: "OPERATOR_CLOSED" })).toBe(false);
    expect(composerFeedWatches({ status: "completed", conversation_id: null, end_reason: "completed" })).toBe(false);
    expect(composerFeedWatches({ status: "queued", conversation_id: "cid" })).toBe(false);
  });
});

describe("composer header bind", () => {
  test("matches workspace, time, and the first user bubble; skips a subagent and a second candidate", () => {
    const run = { prompt: "do the thing", workspaceRoot: "/ws/a", createdAt: 1_000_000 };
    const headers = [
      { composerId: "sub", createdAt: 1_000_010, isSubagent: true, workspacePath: "/ws/a", firstUserText: "do the thing" },
      { composerId: "ok", createdAt: 1_000_006, isSubagent: false, workspacePath: "/ws/a", firstUserText: "do the thing" },
      { composerId: "other", createdAt: 1_000_006, isSubagent: false, workspacePath: "/ws/b", firstUserText: "do the thing" },
      { composerId: "early", createdAt: 1_000_000 - 6_000, isSubagent: false, workspacePath: "/ws/a", firstUserText: "do the thing" },
    ];
    expect(matchComposer(headers, run, new Set())).toBe("ok");
    expect(matchComposer([...headers, { ...headers[1]!, composerId: "also" }], run, new Set())).toBeNull();
  });
});

describe("composer sqlite read", () => {
  test("reads the header workspace and the first user bubble", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, createdAt INTEGER, isSubagent INTEGER, value TEXT);
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
    `);
    const cid = "cid-1";
    db.query("INSERT INTO composerHeaders (composerId, createdAt, isSubagent, value) VALUES (?1,?2,0,?3)").run(
      cid, 50, JSON.stringify({ workspaceIdentifier: { uri: { fsPath: "/Users/apple/Desktop/desk" } } }),
    );
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`composerData:${cid}`, JSON.stringify({
      status: "aborted",
      chatGenerationUUID: "gen-1",
      fullConversationHeadersOnly: [{ bubbleId: "u" }, { bubbleId: "a" }],
      subagentComposerIds: [],
    }));
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`bubbleId:${cid}:u`, JSON.stringify({
      type: 1, text: "hello", requestId: "6bc4f02c-7ae3-4e80-a2b3-b8f613605ee7",
    }));
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`bubbleId:${cid}:a`, JSON.stringify({
      type: 2, text: "", thinking: { text: "hmm" },
    }));
    const headers = readHeaderCandidates(db, 0);
    expect(headers).toEqual([{
      composerId: cid, createdAt: 50, isSubagent: false,
      workspacePath: "/Users/apple/Desktop/desk", firstUserText: "hello",
    }]);
    const view = readComposerView(db, cid);
    expect(view?.generationId).toBe("gen-1");
    expect(view?.status).toBe("aborted");
    expect(view?.bubbles[0]?.requestId).toBe("6bc4f02c-7ae3-4e80-a2b3-b8f613605ee7");
    expect(view?.bubbles[1]?.thinking).toBe("hmm");
    db.close();
  });
});

describe("machine event source", () => {
  let hub: HubServer | null = null;
  afterEach(() => { hub?.stop(); hub = null; });

  test("db mode on this machine drops hook events and keeps table events; another machine cannot switch", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-cdb-"));
    hub = createServer({ port: 0, home, composerCursorPath: join(home, "missing.vscdb") });
    const ws: WebSocket = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w);
      w.onerror = rej;
    });
    ws.send(JSON.stringify({
      type: "register", machineId: "m-local", windowId: "w-1", name: hostname(), os: "darwin",
      openWorkspaces: ["/ws/a"], cdpReady: true,
    }));
    await new Promise((r) => setTimeout(r, 80));
    const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${hub!.port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${hub!.token}`, ...(init?.headers ?? {}) },
    });
    const created = await (await api("/api/runs", {
      method: "POST", body: JSON.stringify({ machineId: "m-local", workspaceRoot: "/ws/a", prompt: "hi" }),
    })).json() as { run: { id: string } };
    ws.send(JSON.stringify({ type: "run.bound", runId: created.run.id, conversationId: "cid-1", promptMatch: true }));
    await new Promise((r) => setTimeout(r, 80));

    hub.db.query("INSERT INTO machines (id, name, os, open_workspaces, status, last_seen_at) VALUES ('m-other','other','win32','[]','online',?1)").run(Date.now());
    const denied = await api("/api/machines/m-other", { method: "PATCH", body: JSON.stringify({ eventSource: "db" }) });
    expect(denied.status).toBe(409);

    const switched = await api("/api/machines/m-local", { method: "PATCH", body: JSON.stringify({ eventSource: "db" }) });
    expect(switched.status).toBe(200);
    const body = await switched.json() as { machine: { event_source: string; local?: boolean } };
    expect(body.machine.event_source).toBe("db");

    const machines = await (await api("/api/machines")).json() as { id: string; local: boolean; event_source: string }[];
    expect(machines.find((m) => m.id === "m-local")).toMatchObject({ local: true, event_source: "db" });

    ws.send(JSON.stringify({
      type: "run.event", runId: created.run.id, source: "hook", hookEventName: "afterAgentThought",
      payload: { text: "from hook", conversation_id: "cid-1" }, ts: Date.now(), seq: 1,
    }));
    ws.send(JSON.stringify({
      type: "run.event", runId: created.run.id, source: "db", hookEventName: "afterAgentThought",
      payload: { text: "from table", conversation_id: "cid-1" }, ts: Date.now(), seq: 2,
    }));
    await new Promise((r) => setTimeout(r, 80));
    const events = await (await api(`/api/runs/${created.run.id}/events?limit=20`)).json() as { source: string; payload: string }[];
    const thoughts = events.filter((e) => e.payload.includes("from "));
    expect(thoughts.map((e) => e.source)).toEqual(["db"]);
    ws.close();
  });
});
