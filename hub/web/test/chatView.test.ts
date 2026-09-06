import { describe, expect, test } from "bun:test";
import { assistantBodyText, eventsToChat, extractUserText, segmentChat } from "../src/chatView";
import type { ChatBlock } from "../src/chatView";
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
    // seq 归位：orphan BSP 不得垫到助手后面
    expect(blocks.map((b) => `${b.kind}:${"text" in b ? b.text : ""}`)).toEqual([
      "user:你会什么技能",
      "user:旧问题",
      "assistant:旧回答",
    ]);
  });

  test("orphan mid-range BSP users insert by seq, not after latest assistant (screenshot disorder)", () => {
    // Real shape: jsonl missing some user lines; hooks still have them. Old code dumped
    // extraUsers after the whole transcript → commit/push bubbles under "已经 push 了".
    const blocks = eventsToChat([
      ev({ seq: 10, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n先看 SSRF\n</user_query>" }] },
      }) }),
      ev({ seq: 11, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "先改文案。" }] },
      }) }),
      ev({ seq: 20, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({
        prompt: "帮我commit提交一下内容，然后告诉我两个分支我换台电脑交叉review一下",
      }) }),
      ev({ seq: 30, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\npush了么？我再让另一台电脑review一下\n</user_query>" }] },
      }) }),
      ev({ seq: 31, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "已经 push 了，本地与 origin 一致。" }] },
      }) }),
      ev({ seq: 25, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({
        prompt: "push一下，要rebase一下最新的main",
      }) }),
    ]);
    const ua = blocks.filter((b) => b.kind === "user" || b.kind === "assistant");
    expect(ua.map((b) => b.kind)).toEqual([
      "user", "assistant", "user", "user", "user", "assistant",
    ]);
    expect(ua.map((b) => b.seq)).toEqual([10, 11, 20, 25, 30, 31]);
    expect(ua[2]).toMatchObject({
      kind: "user",
      text: "帮我commit提交一下内容，然后告诉我两个分支我换台电脑交叉review一下",
    });
    expect(ua[3]).toMatchObject({ kind: "user", text: "push一下，要rebase一下最新的main" });
    expect(ua[5]).toMatchObject({ kind: "assistant", text: "已经 push 了，本地与 origin 一致。" });
  });

  test("hub+hook followup BSP of the same text is one extra user until jsonl arrives (r-0f0eadc6)", () => {
    // Real shape: followup writes hub beforeSubmitPrompt then Mac composer hook with
    // the same prompt; transcript user_query is still in-flight. extraUsers must not
    // paint two identical pills (screenshot 2026-09-04).
    const followup = "先处理已经review出来的内容的问题";
    const blocks = eventsToChat([
      ev({ seq: 2275, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\nreview结果出来了么？\n</user_query>" }] },
      }) }),
      ev({ seq: 2279, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "三个审查被中断，正在重拉。" }] },
      }) }),
      ev({ seq: 2286, source: "hub", hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: followup }) }),
      ev({ seq: 2287, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: followup }) }),
    ]);
    const users = blocks.filter((b) => b.kind === "user");
    expect(users.map((b) => `${b.seq}:${"text" in b ? b.text : ""}`)).toEqual([
      "2275:review结果出来了么？",
      `2286:${followup}`,
    ]);
  });

  test("empty afterAgentResponse still keeps cid-owned transcript body when leftover prompt matches hooks", () => {
    const leftover = "Findesk-fde rebase leftover TL;DR ".repeat(4).trim();
    expect(leftover.length).toBeGreaterThanOrEqual(80);
    expect(leftover.includes("0. 总览")).toBe(false);
    const followup = "排查 office_doc";
    const events = [
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: leftover }) }),
      ev({ seq: 10, source: "hub", hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: followup }) }),
      ev({ seq: 11, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: followup }) }),
      ev({ seq: 20, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: `<user_query>\n${followup}\n</user_query>` }] },
      }) }),
      ev({ seq: 21, hook_event_name: "afterAgentThought", payload: JSON.stringify({ text: "E_STDIN_EMPTY" }) }),
      ev({ seq: 30, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "## 0. 总览\n| 项 | 内容 |\n" }] },
      }) }),
      ev({ seq: 31, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "" }) }),
    ];
    const blocks = eventsToChat(events);
    expect(assistantBodyText(blocks)).toContain("0. 总览");
  });

  test("cross-turn identical user lines from transcript both survive", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n继续\n</user_query>" }] },
      }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "好的" }] },
      }) }),
      ev({ seq: 10, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n继续\n</user_query>" }] },
      }) }),
      ev({ seq: 11, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "好的" }] },
      }) }),
    ]);
    const ua = blocks.filter((b) => b.kind === "user" || b.kind === "assistant");
    expect(ua.map((b) => `${b.kind}:${"text" in b ? b.text : ""}:${b.seq}`)).toEqual([
      "user:继续:1",
      "assistant:好的:2",
      "user:继续:10",
      "assistant:好的:11",
    ]);
  });

  test("transcript image-only user line shows as [图片] instead of dropping", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n[Image]\n<image_files>x.png</image_files>\n</user_query>" }] },
      }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "看到了" }] },
      }) }),
    ]);
    expect(blocks).toEqual([
      { kind: "user", text: "[图片]", seq: 1 },
      { kind: "assistant", text: "看到了", seq: 2 },
    ]);
  });

  test("hub followup with attachmentIds and empty prompt shows [图片]", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "", attachmentIds: ["abc"] }) }),
    ]);
    expect(blocks).toEqual([{ kind: "user", text: "[图片]", seq: 1 }]);
  });

  // 现网曾靠 hookHasPrompt 走纯 hook 路径碰巧同形；现在测 fromEnd 合并。
  test("fromEnd prefix hooks plus transcript still show both turns", () => {
    const prompt = "不完全是重名。\n\n更精确地说：\n\n1. 先加过 test。";
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt }) }),
      ev({ seq: 2, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "第一轮答复。" }) }),
      ev({ seq: 3, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "长期方案呢？" }) }),
      ev({ seq: 4, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "## 11. 修订记录\n完。" }) }),
      ev({ seq: 10, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n长期方案呢？\n</user_query>" }] },
      }) }),
      ev({ seq: 11, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "## 11. 修订记录\n完。" }] },
      }) }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(blocks[0]).toMatchObject({ kind: "user", seq: 1 });
    if (blocks[0].kind === "user") expect(blocks[0].text.startsWith("不完全是重名。")).toBe(true);
    expect(blocks[1]).toMatchObject({ kind: "assistant", text: "第一轮答复。" });
    expect(blocks[2]).toMatchObject({ kind: "user", text: "长期方案呢？" });
    expect(blocks[3]).toMatchObject({ kind: "assistant", text: "## 11. 修订记录\n完。" });
  });

  test("background Task follow-up turn after parent turn_ended still shows the review body", () => {
    // Real shape (r-0f0eadc6 / a746cf16): parent launches run_in_background Tasks,
    // jsonl writes turn_ended, then Cursor injects a follow-up user_query and the
    // parent assistant summarizes the child return. Armada must keep that body.
    const blocks = eventsToChat([
      ev({ seq: 2275, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\nreview结果出来了么？\n</user_query>" }] },
      }) }),
      ev({ seq: 2279, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "**还没有。** 上次三个 Kimi K3 审查在跑到一半时被中断，没有产出结论。" }] },
      }) }),
      ev({ seq: 2280, source: "transcript", payload: JSON.stringify({ type: "turn_ended", status: "success" }) }),
      ev({ seq: 2282, hook_event_name: "stop", payload: JSON.stringify({
        status: "completed", conversation_id: "a746cf16-81d3-4fe7-8d57-67903fb845a8",
      }) }),
      ev({ seq: 2300, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>Perform any necessary follow-up actions in response to the subagent completion above.</user_query>" }] },
      }) }),
      ev({ seq: 2301, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "[web 审查](a7bcf55d) 已完成，middleware / finclaw 两个还在跑。\n\n**结论：可合并，无 Critical。**" }] },
      }) }),
    ]);
    expect(assistantBodyText(blocks)).toContain("可合并，无 Critical");
    const asst = blocks.filter((b) => b.kind === "assistant");
    expect(asst).toHaveLength(2);
    expect(asst[1]).toMatchObject({ kind: "assistant", seq: 2301 });
  });

  test("when followup tails fromEnd, hook turns before first transcript stay in front", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "先修槽位" }) }),
      ev({ seq: 2, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "第一轮答复。" }) }),
      ev({ seq: 3, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "长期方案呢？" }) }),
      ev({ seq: 10, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n长期方案呢？\n</user_query>" }] },
      }) }),
      ev({ seq: 11, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "## 11. 修订记录" }] },
      }) }),
    ]);
    expect(blocks.map((b) => `${b.kind}:${"text" in b ? b.text : ""}`)).toEqual([
      "user:先修槽位",
      "assistant:第一轮答复。",
      "user:长期方案呢？",
      "assistant:## 11. 修订记录",
    ]);
  });

  test("parallel Task starts with empty description stay three cards; one stop does not drop the others", () => {
    // Real Cursor 3.18: subagentStart.description is empty; title was "子代理" and
    // collapsed. finish() then dropped every running card once any sibling completed.
    const mwTask = "Independent Senior Code Review of FULL chatkit-middleware branch.";
    const webTask = "Independent Senior Code Review of FULL chatkit-web branch.";
    const fcTask = "Independent Senior Code Review of FULL finclaw branch.";
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\nreview\n</user_query>" }] },
      }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [
          { type: "text", text: "并行审查。" },
          { type: "tool_use", name: "Task", input: { description: "Kimi MW branch review", prompt: mwTask, model: "kimi-k3-max" } },
          { type: "tool_use", name: "Task", input: { description: "Kimi web branch review", prompt: webTask, model: "kimi-k3-max" } },
          { type: "tool_use", name: "Task", input: { description: "Kimi finclaw branch review", prompt: fcTask, model: "kimi-k3-max" } },
        ] },
      }) }),
      ev({ seq: 3, hook_event_name: "subagentStart", payload: JSON.stringify({
        subagent_id: "call-mw\nfc_0", task: mwTask, model: "kimi-k3-max",
      }) }),
      ev({ seq: 4, hook_event_name: "subagentStart", payload: JSON.stringify({
        subagent_id: "call-web\nfc_1", task: webTask, model: "kimi-k3-max",
      }) }),
      ev({ seq: 5, hook_event_name: "subagentStart", payload: JSON.stringify({
        subagent_id: "call-fc\nfc_2", task: fcTask, model: "kimi-k3-max",
      }) }),
      ev({ seq: 6, hook_event_name: "subagentStop", payload: JSON.stringify({
        subagent_id: "call-web\nfc_1", task: webTask, description: "Kimi web branch review",
        status: "completed", duration_ms: 235344, model: "kimi-k3-max",
      }) }),
    ]);
    const subs = blocks.filter((b) => b.kind === "subagent");
    expect(subs).toHaveLength(3);
    expect(subs.map((b) => b.kind === "subagent" ? `${b.title}:${b.status}` : "")).toEqual([
      "Kimi MW branch review:running",
      "Kimi web branch review:completed",
      "Kimi finclaw branch review:running",
    ]);
  });

  test("child jsonl assistant return attaches to the matching Task card, not the parent body", () => {
    const webTask = "Independent Senior Code Review of FULL chatkit-web branch.";
    const review = "# chatkit-web 独立评审\n\n**结论：可合并，无 Critical。**";
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\nreview\n</user_query>" }] },
      }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [
          { type: "text", text: "先拉审查。" },
          { type: "tool_use", name: "Task", input: { description: "Kimi web branch review", prompt: webTask } },
        ] },
      }) }),
      ev({ seq: 10, source: "subagent-transcript", payload: JSON.stringify({
        __subagent_cid: "a7bcf55d-baaa-41fb-95ec-e4b600bc9773",
        role: "user",
        message: { content: [{ type: "text", text: `<user_query>\n${webTask}\n</user_query>` }] },
      }) }),
      ev({ seq: 11, source: "subagent-transcript", payload: JSON.stringify({
        __subagent_cid: "a7bcf55d-baaa-41fb-95ec-e4b600bc9773",
        role: "assistant",
        message: { content: [{ type: "text", text: "Let me start by reading the diff." }] },
      }) }),
      ev({ seq: 12, source: "subagent-transcript", payload: JSON.stringify({
        __subagent_cid: "a7bcf55d-baaa-41fb-95ec-e4b600bc9773",
        role: "assistant",
        message: { content: [{ type: "text", text: review }] },
      }) }),
    ]);
    expect(assistantBodyText(blocks)).toBe("先拉审查。");
    expect(assistantBodyText(blocks)).not.toContain("可合并，无 Critical");
    const subs = blocks.filter((b) => b.kind === "subagent");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      kind: "subagent",
      title: "Kimi web branch review",
      text: review,
      cid: "a7bcf55d-baaa-41fb-95ec-e4b600bc9773",
    });
  });
});

describe("segmentChat", () => {
  const thought = (seq: number, text: string): ChatBlock => ({ kind: "thought", seq, text });
  const user = (seq: number, text: string): ChatBlock => ({ kind: "user", seq, text });
  const asst = (seq: number, text: string): ChatBlock => ({ kind: "assistant", seq, text });
  const tool = (seq: number, name: string): ChatBlock => ({ kind: "tool", seq, name, summary: name });

  test("lists thoughts while the turn has no assistant yet", () => {
    const segs = segmentChat([user(1, "hi"), thought(2, "先想"), tool(3, "Shell")]);
    expect(segs.map((s) => s.kind)).toEqual(["user", "thought", "tool"]);
  });

  test("folds thoughts and tools into one process after the assistant reply", () => {
    const segs = segmentChat([
      user(1, "hi"), thought(2, "先想"), tool(3, "Shell"), asst(4, "好了"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["user", "process", "assistant"]);
    const proc = segs[1];
    expect(proc.kind).toBe("process");
    if (proc.kind !== "process") return;
    expect(proc.collapsed).toBe(true);
    expect(proc.steps.map((s) => s.kind)).toEqual(["thought", "tool"]);
  });

  test("completed turn folds; live follow-up turn stays listed", () => {
    const segs = segmentChat([
      user(1, "a"), thought(2, "t1"), asst(3, "done"),
      user(4, "b"), thought(5, "t2"), tool(6, "Read"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["user", "process", "assistant", "user", "thought", "tool"]);
  });

  test("assistantBodyText joins assistant replies and skips process", () => {
    expect(assistantBodyText([
      user(1, "hi"), thought(2, "想"), asst(3, "先改。"), asst(4, "好了。"),
    ])).toBe("先改。\n\n好了。");
    expect(assistantBodyText([user(1, "hi")])).toBe("");
  });
});
