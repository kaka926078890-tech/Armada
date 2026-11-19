import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { TRANSCRIPT_BIND_WINDOW_MS } from "../../extension/src/transcriptBind";
import {
  composerBindAnchor, composerFeedWatches, cursorFromEmitted, dispatchUserText, emptyCursor, matchComposer, matchComposerByCreatedAt, planComposerTick, readComposerView, readHeaderCandidates,
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

  // r-4900ac33: the reply step has turnDurationMs while chatGenerationUUID stays.
  // Waiting for the uuid to clear left the card spinning and finalText empty.
  test("a reply step with turnDurationMs stops while chatGenerationUUID remains", () => {
    const armed = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-1",
      bubbles: [
        bubble({ id: "u", type: 1, text: "那就测试", requestId: "gen-1" }),
        bubble({ id: "tool", toolName: "Shell", toolStatus: "completed", toolInput: { command: "echo" } }),
        bubble({ id: "s12", type: 2, text: "先看一眼" }),
      ],
    }), [], emptyCursor()).cursor;
    expect(armed.stopped).toBe(false);

    const done = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-1",
      bubbles: [
        bubble({ id: "u", type: 1, text: "那就测试", requestId: "gen-1" }),
        bubble({ id: "tool", toolName: "Shell", toolStatus: "completed", toolInput: { command: "echo" } }),
        bubble({ id: "s12", type: 2, text: "先看一眼" }),
        bubble({ id: "s32", type: 2, text: "补测跑完了。", turnDurationMs: 219447 }),
      ],
    }), [], armed);
    const bodyAt = done.events.findIndex((e) => e.hook === "afterAgentResponse" && e.payload.text === "补测跑完了。");
    const stopAt = done.events.findIndex((e) => e.hook === "stop");
    expect(bodyAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(bodyAt);
    expect(done.events[stopAt]?.payload).toMatchObject({ status: "completed", generation_id: "gen-1" });
    expect(done.cursor.stopped).toBe(true);
  });

  test("an in-progress step without turnDurationMs does not stop", () => {
    const { events, cursor } = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-1",
      bubbles: [
        bubble({ id: "u", type: 1, text: "那就测试", requestId: "gen-1" }),
        bubble({ id: "tool", toolName: "Shell", toolStatus: "completed", toolInput: { command: "echo" } }),
        bubble({ id: "s12", type: 2, text: "先看一眼" }),
      ],
    }), [], emptyCursor());
    expect(events.some((e) => e.hook === "stop")).toBe(false);
    expect(cursor.stopped).toBe(false);
  });

  test("uuid clear after the reply was already emitted still stops that turn", () => {
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "first", bubble_id: "u1", generation_id: "gen-1", conversation_id: "cid-1" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "old", bubble_id: "a1", generation_id: "gen-1", conversation_id: "cid-1" } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-1", conversation_id: "cid-1" } },
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "second", bubble_id: "u2", generation_id: "gen-2", conversation_id: "cid-1" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "the reply", bubble_id: "s18", generation_id: "gen-2", conversation_id: "cid-1" } },
    ]);
    const { events } = planComposerTick(snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first", requestId: "gen-1" }),
        bubble({ id: "a1", type: 2, text: "old" }),
        bubble({ id: "u2", type: 1, text: "second", requestId: "gen-2" }),
        bubble({ id: "s18", type: 2, text: "the reply", turnDurationMs: 101977 }),
      ],
    }), [], cursor);
    expect(events.find((e) => e.hook === "stop")?.payload).toMatchObject({
      status: "completed",
      generation_id: "gen-2",
    });
  });

  // r-af47f349 s:29: the reply was stored as "……0.4." and the same step later
  // grew to "……0.4.54 ……". The card had already shown the short snapshot.
  test("a reply step that grows after the first flush emits the full text", () => {
    const short = "所以不是没做。0.4.";
    const full = "所以不是没做。0.4.54 为了避免迟到 jsonl 把还在跑的任务打成异常，把整条 jsonl 停跑都停了。";
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "以前如果处理过", bubble_id: "u", generation_id: "gen-1", conversation_id: "cid-1" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: short, bubble_id: "s29", generation_id: "gen-1", conversation_id: "cid-1" } },
    ]);
    const grown = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-1",
      bubbles: [
        bubble({ id: "u", type: 1, text: "以前如果处理过", requestId: "gen-1" }),
        bubble({ id: "s29", type: 2, text: full, turnDurationMs: 96762 }),
      ],
    }), [], cursor);
    const bodies = grown.events.filter((e) => e.hook === "afterAgentResponse" && e.payload.bubble_id === "s29");
    expect(bodies.map((e) => e.payload.text)).toEqual([full]);
    const bodyAt = grown.events.findIndex((e) => e.payload.text === full);
    const stopAt = grown.events.findIndex((e) => e.hook === "stop");
    expect(bodyAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(bodyAt);
    expect(grown.events[stopAt]?.payload).toMatchObject({ status: "completed", generation_id: "gen-1" });
  });

  test("a generation swap does not stop on the previous turn's turnDurationMs", () => {
    const armed = planComposerTick(snap({
      cid: "cid-1",
      status: "generating",
      generationId: "gen-1",
      bubbles: [
        bubble({ id: "u1", type: 1, text: "check", requestId: "gen-1" }),
        bubble({ id: "body", type: 2, text: "the real body" }),
      ],
    }), [], emptyCursor()).cursor;
    const swapped = planComposerTick(snap({
      cid: "cid-1",
      status: "generating",
      generationId: "gen-2",
      bubbles: [
        bubble({ id: "u1", type: 1, text: "check", requestId: "gen-1" }),
        bubble({ id: "body", type: 2, text: "the real body", turnDurationMs: 5000 }),
      ],
    }), [], armed);
    expect(swapped.events.some((e) => e.hook === "stop")).toBe(false);
    expect(swapped.events.some((e) => e.hook === "afterAgentResponse")).toBe(false);
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

  // r-cf2d0a37: tools and thoughts, then Cursor inserts "Briefly inform the user".
  // The same tick used to stop the open generation as aborted. The protocol
  // sentence cannot reopen a terminal card, so its later reply never completed.
  test("protocol inform after tools does not abort the open turn", () => {
    const prior = "18326b5d-6d34-4ff3-a3c5-c0415e099e2f";
    const nextGen = "f422a6e7-8438-4de0-8749-2de83211c83f";
    const protocol = "<timestamp>Thursday, Nov 12, 2026, 3:25 PM (UTC+8)</timestamp>\n<system_notification>The beginning of the above subagent result is already visible to the user.</system_notification>\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.</user_query>";
    const open = [
      bubble({ id: "u1", type: 1, text: "upload the package" }),
      bubble({ id: "th", type: 2, thinking: "checking the directory", text: "" }),
      bubble({ id: "tool", type: 2, toolName: "Shell", toolStatus: "completed", text: "", toolInput: { command: "echo" } }),
    ];
    const armed = planComposerTick(snap({
      cid: "cid-1",
      status: "generating",
      generationId: prior,
      bubbles: open,
    }), [], emptyCursor()).cursor;
    expect(armed.stopped).toBe(false);

    const cut = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: nextGen,
      bubbles: [
        ...open,
        bubble({ id: "u2", type: 1, text: protocol, requestId: nextGen }),
      ],
    }), [], armed);
    expect(cut.events.some((e) => e.hook === "stop")).toBe(false);
    expect(cut.events.find((e) => e.hook === "beforeSubmitPrompt" && e.payload.bubble_id === "u2")?.payload.generation_id).toBe(nextGen);
    expect(cut.cursor.stopped).toBe(false);

    const replied = snap({
      cid: "cid-1",
      status: "aborted",
      generationId: null,
      bubbles: [
        ...open,
        bubble({ id: "u2", type: 1, text: protocol, requestId: nextGen }),
        bubble({ id: "a2", type: 2, text: "the package is uploaded" }),
      ],
    });
    const hold = planComposerTick(replied, [], cut.cursor);
    const done = hold.events.some((e) => e.hook === "stop") ? hold : planComposerTick(replied, [], hold.cursor);
    expect(done.events.find((e) => e.hook === "stop")?.payload).toMatchObject({
      status: "completed",
      generation_id: nextGen,
    });
  });

  // r-cf2d0a37: reload attaches with an empty cursor. The previous reply is
  // still in the composer. It must not become the new generation's body or stop.
  test("an older reply does not complete the generation that just opened", () => {
    const prior = "e50f0442-6d34-4ff3-a3c5-c0415e099e2f";
    const live = "f6663ddf-8438-4de0-8749-2de83211c83f";
    const older = "上传已经完成。ZA 0.1.7 安装包在 COS 上的地址是：";
    const view = snap({
      cid: "cid-1",
      status: "aborted",
      generationId: live,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "upload the package", requestId: prior }),
        bubble({ id: "a1", type: 2, text: older }),
        bubble({ id: "u2", type: 1, text: "当前分支除开Finsafe，哪些是固定的能力缺陷", requestId: live }),
      ],
    });
    const first = planComposerTick(view, [], emptyCursor());
    expect(first.events.some((e) => e.hook === "afterAgentResponse" && e.payload.text === older)).toBe(false);
    expect(first.events.some((e) => e.hook === "stop")).toBe(false);
    expect(first.events.find((e) => e.hook === "beforeSubmitPrompt" && e.payload.bubble_id === "u1")?.payload.generation_id).toBe(prior);
    expect(first.events.find((e) => e.hook === "beforeSubmitPrompt" && e.payload.bubble_id === "u2")?.payload.generation_id).toBe(live);

    const idle = { ...view, generationId: null };
    const hold = planComposerTick(idle, [], first.cursor);
    const settled = hold.events.some((e) => e.hook === "stop") ? hold : planComposerTick(idle, [], hold.cursor);
    expect(settled.events.some((e) => e.hook === "stop")).toBe(false);
    expect(settled.events.some((e) => e.hook === "afterAgentResponse" && e.payload.text === older)).toBe(false);
    expect(settled.cursor.stopped).toBe(false);

    const replied = {
      ...idle,
      bubbles: [...view.bubbles, bubble({ id: "a2", type: 2, text: "the new answer" })],
    };
    const withReply = planComposerTick(replied, [], settled.cursor);
    const finished = withReply.events.some((e) => e.hook === "stop") ? withReply : planComposerTick(replied, [], withReply.cursor);
    expect(finished.events.find((e) => e.hook === "afterAgentResponse")?.payload).toMatchObject({
      text: "the new answer",
      generation_id: live,
    });
    expect(finished.events.find((e) => e.hook === "stop")?.payload).toMatchObject({
      status: "completed",
      generation_id: live,
    });
  });

  // r-4900ac33 16:50:09: a shell task's system_notification arrives in the same
  // tick as the reply. That bubble is not an operator follow-up. Closing the
  // turn here marks the card completed and the desktop banners "任务完成"
  // while the agent is still reading files.
  test("a shell-finished notification does not complete a turn that already replied", () => {
    const shell = "<timestamp>Tuesday, Nov 17, 2026, 4:50 PM (UTC+8)</timestamp>\n<system_notification>\nThe following task has finished. If you were already aware, ignore this notification and do not restate prior responses.\n</system_notification>";
    const open = [
      bubble({ id: "u1", type: 1, text: "落地处理一下", requestId: "gen-1" }),
      bubble({ id: "tool", toolName: "Shell", toolStatus: "completed", toolInput: { command: "echo" } }),
      bubble({ id: "body", type: 2, text: "两处都已落在新进程上。" }),
    ];
    const armed = planComposerTick(snap({
      cid: "cid-1",
      status: "generating",
      generationId: "gen-1",
      bubbles: open,
    }), [], emptyCursor()).cursor;
    expect(armed.stopped).toBe(false);

    const continued = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-2",
      bubbles: [
        ...open,
        bubble({ id: "u2", type: 1, text: shell, requestId: "gen-2" }),
      ],
    }), [], armed);
    expect(continued.events.some((e) => e.hook === "afterAgentResponse" && e.payload.text === "两处都已落在新进程上。")).toBe(true);
    expect(continued.events.some((e) => e.hook === "stop")).toBe(false);
    expect(continued.cursor.stopped).toBe(false);

    const informed = `${shell}\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>`;
    const replied = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-2",
      bubbles: [
        ...open,
        bubble({ id: "u2", type: 1, text: shell, requestId: "" }),
        bubble({ id: "u3", type: 1, text: informed, requestId: "gen-2" }),
        bubble({ id: "tail", type: 2, text: "已经核对过。", turnDurationMs: 8000 }),
      ],
    }), [], continued.cursor);
    const done = replied.events.some((e) => e.hook === "stop") ? replied : planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-2",
      bubbles: [
        ...open,
        bubble({ id: "u2", type: 1, text: shell, requestId: "" }),
        bubble({ id: "u3", type: 1, text: informed, requestId: "gen-2" }),
        bubble({ id: "tail", type: 2, text: "已经核对过。", turnDurationMs: 8000 }),
      ],
    }), [], replied.cursor);
    expect(done.events.find((e) => e.hook === "stop")?.payload).toMatchObject({
      status: "completed",
      generation_id: "gen-2",
    });
  });

  test("an operator follow-up with no assistant text still aborts the open turn", () => {
    const open = [
      bubble({ id: "u1", type: 1, text: "upload the package" }),
      bubble({ id: "tool", type: 2, toolName: "Shell", toolStatus: "completed", text: "", toolInput: { command: "echo" } }),
    ];
    const armed = planComposerTick(snap({
      cid: "cid-1",
      status: "generating",
      generationId: "gen-1",
      bubbles: open,
    }), [], emptyCursor()).cursor;
    const { events } = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-2",
      bubbles: [
        ...open,
        bubble({ id: "u2", type: 1, text: "second" }),
      ],
    }), [], armed);
    const stop = events.find((e) => e.hook === "stop");
    expect(stop?.payload).toMatchObject({ status: "aborted", generation_id: "gen-1" });
    expect(events.some((e) => e.hook === "beforeSubmitPrompt" && e.payload.prompt === "second")).toBe(true);
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

  // r-6ddc3f97: the answer is already in a text bubble, then chatGenerationUUID
  // swaps, and only the next tick brings "Briefly inform" with an empty requestId.
  // The swap tick must not emit the body. The protocol tick must, without stopping.
  test("a body already written before the generation swap flushes when the protocol user arrives later", () => {
    const protocol = "<timestamp>Thursday, Nov 12, 2026, 5:20 PM (UTC+8)</timestamp>\n<system_notification>The following task has finished.</system_notification>\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>";
    const open = [
      bubble({ id: "u1", type: 1, text: "check the package", requestId: "gen-1" }),
      bubble({ id: "tool", toolName: "Shell", toolStatus: "completed", toolInput: { command: "ls" } }),
      bubble({ id: "body", type: 2, text: "今天这份 ZA 包里，托管 Node 是齐的。" }),
    ];
    const armed = planComposerTick(snap({
      cid: "cid-1",
      status: "generating",
      generationId: "gen-1",
      bubbles: open,
    }), [], emptyCursor()).cursor;
    const swapped = planComposerTick(snap({
      cid: "cid-1",
      status: "generating",
      generationId: "gen-2",
      bubbles: open,
    }), [], armed);
    expect(swapped.events.some((e) => e.hook === "afterAgentResponse")).toBe(false);
    expect(swapped.events.some((e) => e.hook === "stop")).toBe(false);

    const informed = planComposerTick(snap({
      cid: "cid-1",
      status: "generating",
      generationId: "gen-2",
      bubbles: [
        ...open,
        bubble({ id: "u2", type: 1, text: protocol, requestId: "" }),
      ],
    }), [], swapped.cursor);
    const body = informed.events.find((e) => e.hook === "afterAgentResponse");
    expect(body?.payload).toMatchObject({ text: "今天这份 ZA 包里，托管 Node 是齐的。", generation_id: "gen-1", bubble_id: "body" });
    expect(informed.events.some((e) => e.hook === "stop")).toBe(false);
    expect(informed.cursor.stopped).toBe(false);

    const done = planComposerTick(snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        ...open,
        bubble({ id: "u2", type: 1, text: protocol, requestId: "" }),
        bubble({ id: "tail", type: 2, text: "全盘查找已经结束。" }),
      ],
    }), [], informed.cursor);
    expect(done.events.find((e) => e.hook === "afterAgentResponse" && e.payload.bubble_id === "tail")?.payload.generation_id).toBe("gen-2");
    expect(done.events.filter((e) => e.payload.bubble_id === "body")).toHaveLength(0);
    expect(done.events.find((e) => e.hook === "stop")?.payload).toMatchObject({ status: "completed", generation_id: "gen-2" });
  });

  // r-97b7ca05: the packaged feed already emitted the users and a stop, then a
  // later turn went live. The earlier text bubbles were never afterAgentResponse.
  // A tick now must flush those closed bodies and leave the live sentence alone.
  test("closed bodies missed by an earlier tick flush while the next turn is live", () => {
    const protocol = "<timestamp>Thursday, Nov 12, 2026, 6:12 PM (UTC+8)</timestamp>\n<system_notification>The following task has finished.</system_notification>\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>";
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "check", bubble_id: "u1", generation_id: "gen-1", conversation_id: "cid-1" } },
      { source: "db", hook: "preToolUse", payload: { tool_name: "Shell", bubble_id: "tool", generation_id: "gen-1", conversation_id: "cid-1" } },
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: protocol, bubble_id: "u2", generation_id: "gen-2", conversation_id: "cid-1" } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-2", conversation_id: "cid-1" } },
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "fix both", bubble_id: "u3", generation_id: "gen-3", conversation_id: "cid-1" } },
    ]);
    const { events, cursor: next } = planComposerTick(snap({
      cid: "cid-1",
      status: "aborted",
      generationId: "gen-3",
      bubbles: [
        bubble({ id: "u1", type: 1, text: "check", requestId: "gen-1" }),
        bubble({ id: "tool", toolName: "Shell", toolStatus: "completed", toolInput: { command: "ls" } }),
        bubble({ id: "body", type: 2, text: "续聊没有发出去。看板仍显示已完成。" }),
        bubble({ id: "u2", type: 1, text: protocol, requestId: "" }),
        bubble({ id: "tail", type: 2, text: "日志定位已经结束。" }),
        bubble({ id: "u3", type: 1, text: "fix both", requestId: "gen-3" }),
        bubble({ id: "live", type: 2, text: "正在看代码。" }),
      ],
    }), [], cursor);
    expect(events.find((e) => e.payload.bubble_id === "body")?.payload).toMatchObject({
      text: "续聊没有发出去。看板仍显示已完成。",
      generation_id: "gen-1",
    });
    expect(events.find((e) => e.payload.bubble_id === "tail")?.payload.text).toBe("日志定位已经结束。");
    expect(events.some((e) => e.payload.bubble_id === "live")).toBe(false);
    expect(events.some((e) => e.hook === "stop")).toBe(false);
    expect(next.stopped).toBe(false);
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

  test("an idle stop carries the armed generation, not an older thought's (r-ac71f2e4)", () => {
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "old", bubble_id: "u1", generation_id: "gen-old", conversation_id: "cid-1" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "finished", bubble_id: "a1", generation_id: "gen-old", conversation_id: "cid-1" } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-old", conversation_id: "cid-1" } },
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "old", bubble_id: "u1", generation_id: "gen-live", conversation_id: "cid-1" } },
      { source: "db", hook: "afterAgentThought", payload: { text: "old thought", bubble_id: "t1", generation_id: "gen-old", conversation_id: "cid-1" } },
    ]);
    expect(cursor.armedGen).toBe("gen-live");
    expect(cursor.generationId).toBe("gen-old");
    const { events } = planComposerTick(snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "old", requestId: "gen-old" }),
        bubble({ id: "a1", type: 2, text: "finished", turnDurationMs: 20 }),
      ],
    }), [], cursor);
    expect(events.find((e) => e.hook === "stop")?.payload.generation_id).toBe("gen-live");
  });

  test("a child whose launch tool already failed does not keep the parent running (r-ac71f2e4)", () => {
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "分析", bubble_id: "u", generation_id: "gen", conversation_id: "parent" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "报告写好了", bubble_id: "a", generation_id: "gen", conversation_id: "parent" } },
      { source: "db", hook: "subagentStart", payload: { conversation_id: "child", parent_conversation_id: "parent" } },
      { source: "subagent-transcript", hook: null, payload: { __subagent_cid: "child", role: "assistant", message: { content: [{ type: "text", text: "blocked" }] } } },
    ]);
    const parent = snap({
      cid: "parent",
      status: "completed",
      generationId: null,
      subagentIds: ["child"],
      bubbles: [
        bubble({ id: "u", type: 1, text: "分析", requestId: "gen" }),
        bubble({ id: "task", toolName: "task_v2", toolStatus: "error", subagentComposerId: "child" }),
        bubble({ id: "a", type: 2, text: "报告写好了", turnDurationMs: 1000 }),
      ],
    });
    const child = snap({
      cid: "child",
      status: "none",
      generationId: "stuck-gen",
      bubbles: [bubble({ id: "c", type: 2, text: "blocked" })],
    });
    const { events } = planComposerTick(parent, [child], cursor);
    expect(events.find((e) => e.hook === "stop")?.payload).toMatchObject({ status: "completed", generation_id: "gen" });
    expect(events.find((e) => e.payload.type === "turn_ended")?.payload.status).toBe("error");
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

  // r-5d82dd7b 13:16:40: follow-up landed while status was still the previous
  // turn's completed, uuid already cleared, and an emitted step row sat after the
  // new user. That tick emitted BSP and stop completed for the new generation.
  test("a new user is not completed by an older step that sorts after it", () => {
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "first", bubble_id: "u1", generation_id: "gen-old" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "old reply", bubble_id: "a1", generation_id: "gen-old" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "step", bubble_id: "a1/s:1", generation_id: "gen-old" } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-old" } },
    ]);
    const opened = planComposerTick(snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first", requestId: "gen-old" }),
        bubble({ id: "a1", type: 2, text: "old reply" }),
        bubble({ id: "u2", type: 1, text: "还有哪些没有进行测试？", requestId: "gen-new" }),
        bubble({ id: "a1/s:1", type: 2, text: "step" }),
      ],
    }), [], cursor);
    expect(opened.events.find((e) => e.hook === "beforeSubmitPrompt")?.payload).toMatchObject({
      prompt: "还有哪些没有进行测试？",
      generation_id: "gen-new",
    });
    expect(opened.events.some((e) => e.hook === "stop")).toBe(false);
    expect(opened.cursor.stopped).toBe(false);

    const answered = planComposerTick(snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first", requestId: "gen-old" }),
        bubble({ id: "a1", type: 2, text: "old reply" }),
        bubble({ id: "u2", type: 1, text: "还有哪些没有进行测试？", requestId: "gen-new" }),
        bubble({ id: "a1/s:1", type: 2, text: "step" }),
        bubble({ id: "a2", type: 2, text: "the new answer" }),
      ],
    }), [], opened.cursor);
    expect(answered.events.find((e) => e.hook === "afterAgentResponse")?.payload).toMatchObject({
      text: "the new answer",
      generation_id: "gen-new",
    });
    expect(answered.events.find((e) => e.hook === "stop")?.payload).toMatchObject({
      status: "completed",
      generation_id: "gen-new",
    });
  });

  // r-7a755f88 18:10:56: header list empty, so the previous turn's /s:1
  // (turnDurationMs already set) sorts after the follow-up. Composer status
  // stays aborted. That tick emitted BSP and stop completed for the new
  // generation, and the later /s:11 body never became afterAgentResponse.
  test("an aborted composer does not complete a follow-up on an older step that sorts after it", () => {
    const prompt = "给我一个提示词，可以定位完问题，并让他从Armada把消息发回你这个卡片";
    const older = "后台那次全盘找日志的命令已经中止，没有影响结论。";
    const userId = "a69e1442-59ec-444a-8e42-a9232784df9c";
    const gen = "c5d3ee5d-30b6-4d47-a32c-f2b6897c46fa";
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "first", bubble_id: "u1", generation_id: "gen-old" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "done once", bubble_id: "a1", generation_id: "gen-old" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: older, bubble_id: "8dd0a101-44ec-4506-a44f-3dd4d8fd1321/s:1", generation_id: "gen-old" } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-old" } },
    ]);
    const base = [
      bubble({ id: "u1", type: 1, text: "first", requestId: "gen-old" }),
      bubble({ id: "a1", type: 2, text: "done once" }),
      bubble({ id: userId, type: 1, text: prompt, requestId: gen }),
    ];
    const olderStep = bubble({
      id: "8dd0a101-44ec-4506-a44f-3dd4d8fd1321/s:1", type: 2, text: older, turnDurationMs: 4484,
    });
    const opened = planComposerTick(snap({
      cid: "cid-1", status: "aborted", generationId: null,
      bubbles: [...base, olderStep],
    }), [], cursor);
    expect(opened.events.find((e) => e.hook === "beforeSubmitPrompt")?.payload).toMatchObject({
      prompt, generation_id: gen,
    });
    expect(opened.events.some((e) => e.hook === "stop")).toBe(false);
    expect(opened.cursor.stopped).toBe(false);

    const tooling = planComposerTick(snap({
      cid: "cid-1", status: "aborted", generationId: gen,
      bubbles: [
        ...base,
        bubble({ id: `${userId}/t:call-f3b9`, toolName: "ripgrep_raw_search", toolStatus: "completed" }),
        olderStep,
      ],
    }), [], opened.cursor);
    expect(tooling.events.some((e) => e.hook === "preToolUse")).toBe(true);
    expect(tooling.events.some((e) => e.hook === "stop")).toBe(false);
    expect(tooling.cursor.stopped).toBe(false);

    const answered = planComposerTick(snap({
      cid: "cid-1", status: "aborted", generationId: null,
      bubbles: [
        ...base,
        bubble({ id: `${userId}/t:call-f3b9`, toolName: "ripgrep_raw_search", toolStatus: "completed" }),
        bubble({ id: `${userId}/s:11`, type: 2, text: "派到 Win Destop。", turnDurationMs: 60989 }),
        olderStep,
      ],
    }), [], tooling.cursor);
    const bodyAt = answered.events.findIndex((e) => e.hook === "afterAgentResponse" && e.payload.text === "派到 Win Destop。");
    const stopAt = answered.events.findIndex((e) => e.hook === "stop");
    expect(bodyAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(bodyAt);
    expect(answered.events[stopAt]?.payload).toMatchObject({ status: "completed", generation_id: gen });
  });

  test("a step that lands after the follow-up was already stopped still reaches the card", () => {
    const userId = "a69e1442-59ec-444a-8e42-a9232784df9c";
    const gen = "c5d3ee5d-30b6-4d47-a32c-f2b6897c46fa";
    const cursor = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "first", bubble_id: "u1", generation_id: "gen-old" } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "done once", bubble_id: "a1", generation_id: "gen-old" } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: "gen-old" } },
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "给我一个提示词", bubble_id: userId, generation_id: gen } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: gen } },
    ]);
    const { events } = planComposerTick(snap({
      cid: "cid-1", status: "aborted", generationId: gen,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first", requestId: "gen-old" }),
        bubble({ id: "a1", type: 2, text: "done once" }),
        bubble({ id: userId, type: 1, text: "给我一个提示词", requestId: gen }),
        bubble({ id: `${userId}/s:11`, type: 2, text: "派到 Win Destop。", turnDurationMs: 60989 }),
        bubble({ id: "8dd0a101-44ec-4506-a44f-3dd4d8fd1321/s:1", type: 2, text: "后台那次全盘找日志的命令已经中止，没有影响结论。", turnDurationMs: 4484 }),
      ],
    }), [], cursor);
    expect(events.some((e) => e.hook === "afterAgentResponse" && e.payload.text === "派到 Win Destop。")).toBe(true);
    expect(events.some((e) => e.hook === "afterAgentResponse" && String(e.payload.text).includes("全盘找日志"))).toBe(false);
    expect(events.some((e) => e.hook === "stop")).toBe(false);
  });

  test("a new user with no reply yet is not aborted by the previous completed status", () => {
    const cursor = stoppedAfterFirstTurn();
    const { events, cursor: next } = planComposerTick(snap({
      cid: "cid-1",
      status: "completed",
      generationId: null,
      bubbles: [
        bubble({ id: "u1", type: 1, text: "first", requestId: "gen-1" }),
        bubble({ id: "a1", type: 2, text: "done once" }),
        bubble({ id: "u2", type: 1, text: "second", requestId: "gen-new" }),
      ],
    }), [], cursor);
    expect(events.some((e) => e.hook === "beforeSubmitPrompt" && e.payload.prompt === "second")).toBe(true);
    expect(events.some((e) => e.hook === "stop")).toBe(false);
    expect(next.stopped).toBe(false);
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
    const started = 1_000_000;
    expect(composerFeedWatches({
      status: "unknown", conversation_id: null, end_reason: "BIND_TIMEOUT", started_at: started, created_at: 1,
    }, started + 60_000)).toBe(true);
    expect(composerFeedWatches({
      status: "unknown", conversation_id: null, end_reason: "BIND_TIMEOUT", started_at: started, created_at: 1,
    }, started + TRANSCRIPT_BIND_WINDOW_MS)).toBe(false);
    expect(composerFeedWatches({
      status: "unknown", conversation_id: null, end_reason: "MACHINE_OFFLINE", started_at: started, created_at: 1,
    }, started)).toBe(false);
    expect(composerBindAnchor({ created_at: 1, started_at: started })).toBe(started);
    expect(composerBindAnchor({ created_at: 1, started_at: null })).toBe(1);
  });
});

describe("windows composer bind", () => {
  const cid = "251e2de9-fef2-4ef9-aadd-663258b24116";
  const bubbleId = "aa287f49-6f3b-4c12-972d-9da1fc11d66b";

  test("empty headers read bubble keys by index range, not a full-table LIKE", () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const db = {
      query(sql: string) {
        return {
          get(...args: unknown[]) {
            calls.push({ sql, args });
            const key = String(args[0] ?? "");
            if (key.startsWith("bubbleId:")) {
              return { value: JSON.stringify({ type: 1, text: "probe", requestId: "g" }) };
            }
            return {
              value: JSON.stringify({
                status: "completed",
                chatGenerationUUID: "",
                fullConversationHeadersOnly: [],
              }),
            };
          },
          all(...args: unknown[]) {
            calls.push({ sql, args });
            return [{ key: `bubbleId:${cid}:${bubbleId}` }];
          },
        };
      },
    };
    const view = readComposerView(db, cid);
    expect(view?.bubbles.map((b) => b.id)).toEqual([bubbleId]);
    expect(calls.some((c) => c.sql.includes("LIKE"))).toBe(false);
    const range = calls.find((c) => c.sql.includes("key >= ?1"));
    expect(range?.args).toEqual([`bubbleId:${cid}:`, `bubbleId:${cid};`]);
  });

  test("empty fullConversationHeadersOnly still reads bubbleId rows and ignores tool fragments", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`composerData:${cid}`, JSON.stringify({
      status: "aborted",
      chatGenerationUUID: CURSOR_GEN,
      fullConversationHeadersOnly: [],
      subagentComposerIds: [],
    }));
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`bubbleId:${cid}:${bubbleId}`, JSON.stringify({
      type: 1, text: "ARMADA-WIN-DB-PROBE-20261111-0922", requestId: CURSOR_GEN,
    }));
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(
      `bubbleId:${cid}:${bubbleId}/t:call-080fe9e1-e15f-4539-b136-2530bd70098e-0`,
      JSON.stringify({ type: 2, text: "tool fragment" }),
    );
    const live = readComposerView(db, cid);
    expect(live?.status).toBe("aborted");
    expect(live?.generationId).toBe(CURSOR_GEN);
    expect(live?.bubbles.map((b) => b.id)).toEqual([bubbleId]);
    const armed = planComposerTick(live!, [], emptyCursor());
    expect(armed.events.some((e) => e.hook === "stop")).toBe(false);
    expect(armed.events.find((e) => e.hook === "beforeSubmitPrompt")?.payload.generation_id).toBe(CURSOR_GEN);
    db.query("UPDATE cursorDiskKV SET value=?1 WHERE key=?2").run(JSON.stringify({
      status: "completed",
      chatGenerationUUID: "",
      fullConversationHeadersOnly: [],
      subagentComposerIds: [],
    }), `composerData:${cid}`);
    const done = planComposerTick(readComposerView(db, cid)!, [], armed.cursor);
    expect(done.events.find((e) => e.hook === "stop")?.payload).toMatchObject({
      status: "completed",
      generation_id: CURSOR_GEN,
    });
    db.close();
  });

  test("empty headers order turns by createdAt, not bubble id (r-ac71f2e4)", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const setComposer = (gen: string) => db.query("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`composerData:${cid}`, JSON.stringify({
      status: "aborted",
      chatGenerationUUID: gen,
      fullConversationHeadersOnly: [],
      subagentComposerIds: [],
    }));
    const put = (id: string, value: unknown) => {
      db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`bubbleId:${cid}:${id}`, JSON.stringify(value));
    };
    const merge = "fda5ce29-799d-46c8-9d94-ac041c2b6464";
    const note = "12b6f6f6-501a-429d-bdf5-7e8e9451419f";
    const mergeGen = "1a76fe6e-d346-42d8-9165-e711eb453882";
    const noteGen = "54460902-63be-41e2-8bd8-873de32d4486";
    put(merge, { type: 1, text: "Findesk可以合并的先合并", requestId: mergeGen, createdAt: "2026-11-19T06:07:53.837Z" });
    put(`${merge}/s:1`, { type: 2, text: "合并完了", turnDurationMs: 298000, createdAt: "2026-11-19T06:12:52.000Z" });
    put(note, {
      type: 1,
      text: "<system_notification>subagent done</system_notification>\n<user_query>Perform any necessary follow-up actions in response to the subagent completion above.</user_query>",
      createdAt: "2026-11-19T06:51:37.170Z",
    });

    setComposer("");
    expect(readComposerView(db, cid)!.bubbles.map((b) => b.id)).toEqual([merge, `${merge}/s:1`, note]);

    const prior = cursorFromEmitted([
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "Findesk可以合并的先合并", bubble_id: merge, generation_id: mergeGen, conversation_id: cid } },
      { source: "db", hook: "afterAgentResponse", payload: { text: "合并完了", bubble_id: `${merge}/s:1`, generation_id: mergeGen, conversation_id: cid } },
      { source: "db", hook: "stop", payload: { status: "completed", generation_id: mergeGen, conversation_id: cid } },
      { source: "db", hook: "beforeSubmitPrompt", payload: { prompt: "<system_notification>", bubble_id: note, conversation_id: cid } },
    ]);
    setComposer(noteGen);
    const armed = planComposerTick(readComposerView(db, cid)!, [], prior);
    const rearmed = armed.events.filter((e) => e.hook === "beforeSubmitPrompt");
    expect(rearmed.map((e) => e.payload.bubble_id)).not.toContain(merge);
    expect(armed.events.some((e) => e.hook === "stop")).toBe(false);

    put(`${note}/s:1`, { type: 2, text: "HTML 报告已经写好", turnDurationMs: 280000, createdAt: "2026-11-19T06:56:10.000Z" });
    expect(readComposerView(db, cid)!.bubbles.map((b) => b.id)).toEqual([merge, `${merge}/s:1`, note, `${note}/s:1`]);
    setComposer("");
    const done = planComposerTick(readComposerView(db, cid)!, [], armed.cursor);
    expect(done.events.find((e) => e.hook === "stop")?.payload).toMatchObject({ status: "completed", generation_id: noteGen });
    db.close();
  });

  test("empty headers keep claude tool rows and drop their fragments", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`composerData:${cid}`, JSON.stringify({
      status: "completed",
      chatGenerationUUID: "",
      fullConversationHeadersOnly: [],
      subagentComposerIds: [],
    }));
    const tool = `${bubbleId}/t:toolu_vrtx_01HB1DfsiEzQRKiKCmZ8VarU`;
    const put = (id: string, value: unknown) => {
      db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`bubbleId:${cid}:${id}`, JSON.stringify(value));
    };
    put(bubbleId, { type: 1, text: "分析", requestId: CURSOR_GEN, createdAt: "2026-11-19T06:46:10.619Z" });
    put(tool, {
      type: 2,
      text: "",
      toolFormerData: {
        name: "task_v2",
        status: "error",
        additionalData: { status: "error", subagentComposerId: "63aa8de0-4c30-46c9-8779-e0d7da327d4a" },
      },
    });
    put(`${tool}/fc_59065b3b`, { type: 2, text: "fragment" });
    const view = readComposerView(db, cid);
    expect(view?.bubbles.map((b) => b.id)).toEqual([bubbleId, tool]);
    expect(view?.bubbles[1]).toMatchObject({
      toolName: "task_v2",
      toolStatus: "error",
      subagentComposerId: "63aa8de0-4c30-46c9-8779-e0d7da327d4a",
    });
    db.close();
  });

  test("empty headers read s: text and thinking, and empty tool calls", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`composerData:${cid}`, JSON.stringify({
      status: "completed",
      chatGenerationUUID: "",
      fullConversationHeadersOnly: [],
      subagentComposerIds: [],
    }));
    const put = (id: string, value: unknown) => {
      db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`bubbleId:${cid}:${id}`, JSON.stringify(value));
    };
    const call = `${bubbleId}/t:call-080fe9e1-e15f-4539-b136-2530bd70098e-0`;
    put(bubbleId, { type: 1, text: "do the thing", requestId: CURSOR_GEN });
    put(`${bubbleId}/s:1`, { type: 2, text: "", thinking: { text: "looking" } });
    put(`${bubbleId}/s:10`, { type: 1, text: "the long report", turnDurationMs: 219447 });
    put(`${bubbleId}/s:2`, { type: 2, text: "short note" });
    put(`${bubbleId}/s:3`, { type: 2, text: "tool said this", toolFormerData: { name: "read_file_v2", status: "completed" } });
    put(call, { type: 2, text: "", toolFormerData: { name: "read_file_v2", status: "completed" } });
    put(`${call}/fc_59065b3b`, { type: 2, text: "file body" });
    const view = readComposerView(db, cid);
    expect(view?.bubbles.map((b) => b.id)).toEqual([
      bubbleId,
      `${bubbleId}/s:1`,
      `${bubbleId}/s:2`,
      `${bubbleId}/s:10`,
      call,
    ]);
    expect(view?.bubbles.find((b) => b.id.endsWith("/s:10"))?.type).toBe(2);
    expect(view?.bubbles.find((b) => b.id.endsWith("/s:10"))?.turnDurationMs).toBe(219447);
    const { events } = planComposerTick(view!, [], emptyCursor());
    expect(events.filter((e) => e.hook === "afterAgentThought").map((e) => e.payload.text)).toEqual(["looking"]);
    expect(events.filter((e) => e.hook === "preToolUse").map((e) => e.payload.tool_name)).toEqual(["read_file_v2"]);
    expect(events.filter((e) => e.hook === "afterAgentResponse").map((e) => e.payload.text)).toEqual([
      "short note",
      "the long report",
    ]);
    db.close();
  });

  test("a finished aborted composer with a reply stops as completed", () => {
    const armed = planComposerTick(snap({
      cid: "cid-1",
      bubbles: [bubble({ id: "u", type: 1, text: "hi" })],
    }), [], emptyCursor()).cursor;
    const cleared = snap({
      cid: "cid-1",
      status: "aborted",
      generationId: null,
      bubbles: [
        bubble({ id: "u", type: 1, text: "hi" }),
        bubble({ id: "a", type: 2, text: "the reply" }),
      ],
    });
    const hold = planComposerTick(cleared, [], armed);
    expect(hold.events.some((e) => e.hook === "stop")).toBe(false);
    const done = planComposerTick(cleared, [], hold.cursor);
    expect(done.events.find((e) => e.hook === "afterAgentResponse")?.payload.text).toBe("the reply");
    expect(done.events.find((e) => e.hook === "stop")?.payload.status).toBe("completed");
  });

  test("a finished aborted composer with no reply still stops as aborted", () => {
    const armed = planComposerTick(snap({
      cid: "cid-1",
      bubbles: [bubble({ id: "u", type: 1, text: "hi" })],
    }), [], emptyCursor()).cursor;
    const cleared = snap({
      cid: "cid-1",
      status: "aborted",
      generationId: null,
      bubbles: [bubble({ id: "u", type: 1, text: "hi" })],
    });
    const hold = planComposerTick(cleared, [], armed);
    expect(hold.events.some((e) => e.hook === "stop")).toBe(false);
    const done = planComposerTick(cleared, [], hold.cursor);
    expect(done.events.find((e) => e.hook === "stop")?.payload.status).toBe("aborted");
  });

  test("binds the composer createNew wrote, without a user bubble and across Windows path case", () => {
    const anchor = 1_794_360_201_000;
    const headers = [
      {
        composerId: cid, createdAt: 1_794_360_201_518, isSubagent: false,
        workspacePath: "c:\\Users\\PC\\Desktop\\work", firstUserText: null,
      },
      {
        composerId: "later", createdAt: anchor + 20_000, isSubagent: false,
        workspacePath: "C:\\Users\\PC\\Desktop\\work", firstUserText: null,
      },
    ];
    expect(matchComposer(headers, {
      prompt: "ARMADA-WIN-DB-PROBE-20261111-0922",
      workspaceRoot: "c:\\Users\\PC\\Desktop\\work",
      createdAt: anchor,
    }, new Set())).toBeNull();
    expect(matchComposerByCreatedAt(headers, {
      workspaceRoot: "c:\\Users\\PC\\Desktop\\work",
      createdAt: anchor,
    }, new Set())).toBe(cid);
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

  test("inbox file chip in front of the prompt still binds that prompt", () => {
    const prompt = "帮忙格式化一下这个小说的格式，调整成更加符合看小说的阅读习惯，而且把无关小说的内容做一下删除，包括但不限于打赏等内容";
    const chip = "@.armada/inbox/r-e4992caf-a504-4298-92ea-b1fa076b112c/0f3eacff-r-e4992caf-a504-4298-92ea-b1fa076b112c-鹏程万里一二未删减整理.txt ";
    const started = 1_795_071_908_000;
    const run = { prompt, workspaceRoot: "/Users/apple/Desktop/desk/generative-ui-customer", createdAt: started };
    const headers = [
      {
        composerId: "1855f0d1-98ef-4751-b808-d82162361e4e",
        createdAt: started - 600_000,
        isSubagent: false,
        workspacePath: run.workspaceRoot,
        firstUserText: chip + prompt,
      },
      {
        composerId: "3c0d9f35-b08d-43d1-8884-e33d91fa2751",
        createdAt: started,
        isSubagent: false,
        workspacePath: run.workspaceRoot,
        firstUserText: chip + prompt,
      },
    ];
    expect(matchComposer(headers, run, new Set())).toBe("3c0d9f35-b08d-43d1-8884-e33d91fa2751");
    expect(matchComposer(headers, { ...run, createdAt: started - 600_000 }, new Set())).toBeNull();
    expect(matchComposer([{
      composerId: "readme", createdAt: started, isSubagent: false,
      workspacePath: run.workspaceRoot, firstUserText: "@README.md " + prompt,
    }], run, new Set())).toBeNull();
  });

  test("a later follow-up that sorts first is not the dispatch prompt", () => {
    const prompt = "帮忙格式化一下这个小说的格式，调整成更加符合看小说的阅读习惯，而且把无关小说的内容做一下删除，包括但不限于打赏等内容";
    const chip = "@.armada/inbox/r-e4992caf-a504-4298-92ea-b1fa076b112c/0f3eacff-r-e4992caf-a504-4298-92ea-b1fa076b112c-鹏程万里一二未删减整理.txt ";
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, createdAt INTEGER, isSubagent INTEGER, value TEXT);
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
    `);
    const cid = "3c0d9f35-b08d-43d1-8884-e33d91fa2751";
    const started = 1_795_071_908_763;
    db.query("INSERT INTO composerHeaders (composerId, createdAt, isSubagent, value) VALUES (?1,?2,0,?3)").run(
      cid, started, JSON.stringify({ workspaceIdentifier: { uri: { fsPath: "/Users/apple/Desktop/desk/generative-ui-customer" } } }),
    );
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`composerData:${cid}`, JSON.stringify({
      status: "completed",
      fullConversationHeadersOnly: [],
      subagentComposerIds: [],
    }));
    const follow = "3cb60800-e9e5-4c2f-8ae3-e54fba5393fc";
    const original = "7cc549a2-12a9-40ef-b3ac-ad6dd9c02626";
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`bubbleId:${cid}:${follow}`, JSON.stringify({
      type: 1, text: "新文件在哪里", startedAtMs: started + 240_000,
    }));
    db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`bubbleId:${cid}:${original}`, JSON.stringify({
      type: 1, text: chip + prompt, startedAtMs: started,
    }));
    const headers = readHeaderCandidates(db, started - 5_000);
    expect(headers[0]?.firstUserText).toBe(chip + prompt);
    expect(dispatchUserText([
      { id: follow, type: 1, text: "新文件在哪里", thinking: "", toolName: "", toolStatus: "", subagentComposerId: "", requestId: "", startedAtMs: started + 240_000 },
      { id: original, type: 1, text: chip + prompt, thinking: "", toolName: "", toolStatus: "", subagentComposerId: "", requestId: "", startedAtMs: started },
    ])).toBe(chip + prompt);
    expect(matchComposer(headers, {
      prompt, workspaceRoot: "/Users/apple/Desktop/desk/generative-ui-customer", createdAt: started,
    }, new Set())).toBe(cid);
    db.close();
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

  test("hub host drops hook events and keeps table events; the source cannot be switched", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-cdb-"));
    hub = createServer({ port: 0, home, composerCursorPath: join(home, "missing.vscdb") });
    const openWs = () => new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub!.port}/ws?token=${hub!.token}`);
      w.onopen = () => res(w);
      w.onerror = rej;
    });
    const ws = await openWs();
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

    const switched = await api("/api/machines/m-local", { method: "PATCH", body: JSON.stringify({ eventSource: "hooks" }) });
    expect(switched.status).toBe(400);
    const machines = await (await api("/api/machines")).json() as { id: string; local: boolean; event_source?: string }[];
    const local = machines.find((m) => m.id === "m-local");
    expect(local).toMatchObject({ local: true });
    expect(local).not.toHaveProperty("event_source");

    const other = await openWs();
    other.send(JSON.stringify({
      type: "register", machineId: "m-other", windowId: "w-2", name: "other-host", os: "darwin",
      openWorkspaces: ["/ws/b"], cdpReady: true,
    }));
    await new Promise((r) => setTimeout(r, 80));
    const otherRun = await (await api("/api/runs", {
      method: "POST", body: JSON.stringify({ machineId: "m-other", workspaceRoot: "/ws/b", prompt: "hi" }),
    })).json() as { run: { id: string } };
    other.send(JSON.stringify({ type: "run.bound", runId: otherRun.run.id, conversationId: "cid-2", promptMatch: true }));
    await new Promise((r) => setTimeout(r, 80));
    other.send(JSON.stringify({
      type: "run.event", runId: otherRun.run.id, source: "hook", hookEventName: "afterAgentThought",
      payload: { text: "from hook", conversation_id: "cid-2" }, ts: Date.now(), seq: 1,
    }));
    await new Promise((r) => setTimeout(r, 80));
    const otherEvents = await (await api(`/api/runs/${otherRun.run.id}/events?limit=20`)).json() as { source: string; payload: string }[];
    expect(otherEvents.filter((e) => e.payload.includes("from hook")).map((e) => e.source)).toEqual(["hook"]);
    ws.close();
    other.close();
  });
});
