import { describe, expect, test } from "bun:test";
import { eventsToChat, extractUserText } from "../src/chatView";
import type { RunEvent } from "../src/types";

function ev(partial: Partial<RunEvent> & { seq: number; payload: string }): RunEvent {
  return {
    id: partial.seq, run_id: "r-1", source: "hook", hook_event_name: null,
    ts: 0, post_terminal: 0, ...partial,
  };
}

describe("extractUserText", () => {
  test("strips timestamp and user_query wrapper", () => {
    const raw = "<timestamp>Saturday, Aug 29, 2026, 8:55 PM (UTC+8)</timestamp>\n<user_query>\n你会什么技能\n</user_query>";
    expect(extractUserText(raw)).toBe("你会什么技能");
  });
});

describe("eventsToChat", () => {
  test("renders transcript as user / assistant / tool, skips turn_ended and raw ids", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n改 hello.txt\n</user_query>" }] },
      }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [
          { type: "text", text: "先改文件。" },
          { type: "tool_use", name: "StrReplace", input: { path: "/ws/hello.txt" } },
        ] },
      }) }),
      ev({ seq: 3, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "ok" }] },
      }) }),
      ev({ seq: 4, source: "transcript", payload: JSON.stringify({ type: "turn_ended", status: "success" }) }),
    ]);
    expect(blocks).toEqual([
      { kind: "user", text: "改 hello.txt", seq: 1 },
      { kind: "assistant", text: "先改文件。", seq: 2 },
      { kind: "tool", name: "StrReplace", summary: "StrReplace · hello.txt", seq: 2 },
      { kind: "assistant", text: "ok", seq: 3 },
    ]);
  });

  test("without transcript, reconstructs from hooks and dedupes identical thoughts", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "回你好" }) }),
      ev({ seq: 2, hook_event_name: "afterAgentThought", payload: JSON.stringify({ text: "直接回复" }) }),
      ev({ seq: 3, hook_event_name: "afterAgentThought", payload: JSON.stringify({ text: "直接回复" }) }),
      ev({ seq: 4, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "你好" }) }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "thought", "assistant"]);
    expect(blocks[2]).toMatchObject({ kind: "assistant", text: "你好" });
  });

  test("does not repeat transcript reply when hook afterAgentResponse duplicates it", () => {
    const blocks = eventsToChat([
      ev({ seq: 10, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\nhi\n</user_query>" }] },
      }) }),
      ev({ seq: 11, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "你好" }] },
      }) }),
      ev({ seq: 12, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "你好" }) }),
    ]);
    expect(blocks.filter((b) => b.kind === "assistant")).toHaveLength(1);
  });

  test("followup beforeSubmitPrompt still shows even if seq is before transcript replay", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "你会什么技能" }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n旧问题\n</user_query>" }] },
      }) }),
      ev({ seq: 3, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "旧回答" }] },
      }) }),
    ]);
    expect(blocks.map((b) => `${b.kind}:${"text" in b ? b.text : ""}`)).toEqual([
      "user:旧问题",
      "assistant:旧回答",
      "user:你会什么技能",
    ]);
  });

  test("with prompt, prefers hooks over unrelated transcript", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "说一句你好" }) }),
      ev({ seq: 2, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "你好。" }) }),
      ev({ seq: 3, hook_event_name: "subagentStart", payload: JSON.stringify({ description: "说一句你好", subagent_model: "cursor-grok-4.6-high" }) }),
      ev({ seq: 4, hook_event_name: "subagentStop", payload: JSON.stringify({ description: "说一句你好", status: "completed", duration_ms: 9794, subagent_model: "cursor-grok-4.6-high" }) }),
      ev({ seq: 10, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "[Image]\n<image_files>x.png</image_files>" }] },
      }) }),
      ev({ seq: 11, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "这段不该出现在本任务里" }] },
      }) }),
    ], "说一句你好");
    expect(blocks.map((b) => b.kind)).toEqual(["user", "assistant", "subagent"]);
    expect(blocks.find((b) => b.kind === "assistant")).toMatchObject({ text: "你好。" });
    expect(blocks.find((b) => b.kind === "subagent")).toMatchObject({ status: "completed", durationMs: 9794 });
  });
});
