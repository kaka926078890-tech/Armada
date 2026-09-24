import { describe, expect, test } from "bun:test";
import { assistantBodyForPrompt, assistantBodyText, lastTurnAssistantBody, eventsToChat, extractUserText, segmentChat, INITIAL_VISIBLE_TURNS, initialHiddenPrefixTurns, recentTurnsWindow, mergeOutboundChat, mergePendingAsk, queuedOutbound, collapseRepeatedTools, processFoldLabel, CURSOR_PROTOCOL_USER_PREFIXES, userMessageCaption, stampFallbackImageIds } from "../src/chatView";
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

describe("Cursor protocol user prefixes", () => {
  test("table is the only hide list; a near-miss stays a user bubble", () => {
    expect([...CURSOR_PROTOCOL_USER_PREFIXES]).toEqual([
      "Perform any necessary follow-up actions",
      "Implement the plan as specified",
      "Briefly inform the user about the task result",
    ]);
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>Please perform follow-up actions if needed.</user_query>" }] },
      }) }),
    ]);
    expect(blocks).toEqual([{ kind: "user", text: "Please perform follow-up actions if needed.", seq: 1 }]);
  });
});

describe("Cursor internal context dump", () => {
  const dump = `<available_subagent_types>
Available subagent_types and a quick description of what they do:
- generalPurpose: General-purpose agent for researching complex questions
</available_subagent_types>
<available_subagent_models>
If the user explicitly asks for the model of a subagent/task, you may ONLY use model slugs from this list:
- inherit (default)
</available_subagent_models>`;

  test("available_subagent_types jsonl user line is thought, not an operator bubble", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n启动工作区会进入无限的死循环，帮忙修复这个问题并commit push\n</user_query>" }] },
      }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [
          { type: "tool_use", name: "Read", input: { path: "/ws/scripts/armada-cursor.sh" } },
        ] },
      }) }),
      ev({ seq: 3, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: dump }] },
      }) }),
    ]);
    expect(blocks.filter((b) => b.kind === "user")).toEqual([
      { kind: "user", text: "启动工作区会进入无限的死循环，帮忙修复这个问题并commit push", seq: 1 },
    ]);
    expect(blocks.some((b) => b.kind === "thought" && b.text.includes("<available_subagent_types>"))).toBe(true);
    const segs = segmentChat(blocks);
    expect(segs.filter((s) => s.kind === "user")).toHaveLength(1);
    const fold = segs.find((s) => s.kind === "process");
    expect(fold?.kind === "process" && fold.steps.some((s) => s.kind === "thought" && s.text.includes("<available_subagent_models>"))).toBe(true);
  });

  test("the same dump wrapped in user_query still folds into process", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: `<user_query>\n${dump}\n</user_query>` }] },
      }) }),
    ]);
    expect(blocks.filter((b) => b.kind === "user")).toEqual([]);
    expect(blocks).toEqual([{ kind: "thought", text: dump, seq: 1 }]);
  });

  test("talking about subagents without the xml tags stays a user bubble", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n帮我看看 available_subagent_types 是什么\n</user_query>" }] },
      }) }),
    ]);
    expect(blocks).toEqual([{ kind: "user", text: "帮我看看 available_subagent_types 是什么", seq: 1 }]);
  });
});

describe("eventsToChat user markdown source", () => {
  const md = "### 标题\n第一行\n第二行\n\n- a";

  test("transcript user_query keeps newlines", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: `<user_query>\n${md}\n</user_query>` }] },
      }) }),
    ]);
    expect(blocks).toEqual([{ kind: "user", text: md, seq: 1 }]);
  });

  test("beforeSubmitPrompt keeps newlines", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: md }) }),
    ]);
    expect(blocks).toEqual([{ kind: "user", text: md, seq: 1 }]);
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
      { kind: "thought", text: "先改文件。", seq: 2 },
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

  test("hub followup and jsonl user_query of the same body are one bubble when jsonl drops a blank line (r-c4b0a986)", () => {
    // Real shape: hub records the typed prompt; Cursor jsonl stores one fewer blank line.
    // Display body is simple content, so extraUsers vs transcript compare as the same sentence.
    const hubPrompt = "成对 pin。\n\n\n帮我确定一下以上review问题存在是否属实？";
    const jsonlPrompt = "成对 pin。\n\n帮我确定一下以上review问题存在是否属实？";
    const body = "成对 pin。\n\n帮我确定一下以上review问题存在是否属实？";
    const blocks = eventsToChat([
      ev({ seq: 10, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\nbrowserskill的问题代码提交了么？\n</user_query>" }] },
      }) }),
      ev({ seq: 74, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "提交了，但只在功能分支上。" }] },
      }) }),
      ev({ seq: 79, source: "hub", hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: hubPrompt }) }),
      ev({ seq: 80, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: hubPrompt }) }),
      ev({ seq: 85, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: `<user_query>\n${jsonlPrompt}\n</user_query>` }] },
      }) }),
    ]);
    const users = blocks.filter((b) => b.kind === "user");
    expect(users.map((b) => `${b.seq}:${"text" in b ? b.text : ""}`)).toEqual([
      "10:browserskill的问题代码提交了么？",
      `85:${body}`,
    ]);
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

  test("hub+hook BSP is one user when transcript has not arrived yet (screenshot 2026-09-07)", () => {
    // Real shape: previous turn is hook-only (AAR table); followup writes hub BSP then
    // Mac composer BSP. lastTx===0 used to dump both into liveHooks with no uniqueUserText.
    const followup = "需要如何处理？而且需要处理一下考虑Windows, Mac Intel, Mac Arm版本的差异";
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "核对 checksum" }) }),
      ev({ seq: 2, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "## 根因\n| 字段 | 值 |" }) }),
      ev({ seq: 10, source: "hub", hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: followup }) }),
      ev({ seq: 11, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: followup }) }),
    ]);
    expect(blocks.map((b) => `${b.kind}:${"text" in b ? b.text : ""}`)).toEqual([
      "user:核对 checksum",
      "assistant:## 根因\n| 字段 | 值 |",
      `user:${followup}`,
    ]);
  });

  test("fromEnd prefixHooks hub+hook BSP of the same text is one user", () => {
    // firstTx is the later jsonl line; both BSP seqs are < firstTx so they used to
    // land in prefixHooks twice. extraUsers uniqueUserText never saw them.
    const followup = "需要如何处理？而且需要处理一下考虑Windows, Mac Intel, Mac Arm版本的差异";
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "核对 checksum" }) }),
      ev({ seq: 2, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "## 根因" }) }),
      ev({ seq: 10, source: "hub", hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: followup }) }),
      ev({ seq: 11, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: followup }) }),
      ev({ seq: 20, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "先改 pin。" }] },
      }) }),
    ]);
    const users = blocks.filter((b) => b.kind === "user");
    expect(users.map((b) => `${b.seq}:${"text" in b ? b.text : ""}`)).toEqual([
      "1:核对 checksum",
      `10:${followup}`,
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
    expect(blocks).toEqual([{ kind: "user", text: "[图片]", seq: 1, imageIds: ["abc"] }]);
  });

  test("transcript [图片] keeps hook attachmentIds for thumbnails", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "", attachmentIds: ["abc"] }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n[Image]\n<image_files>x.png</image_files>\n</user_query>" }] },
      }) }),
    ]);
    expect(blocks).toEqual([{ kind: "user", text: "[图片]", seq: 2, imageIds: ["abc"] }]);
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
    expect(blocks[0]).toMatchObject({ kind: "user", seq: 1, text: prompt });
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
    expect(blocks.filter((b) => b.kind === "user").map((b) => b.kind === "user" ? b.text : "")).toEqual([
      "review结果出来了么？",
    ]);
  });

  test("Cursor protocol turn written twice in jsonl is one assistant bubble (r-a59ee486 seq 287/296)", () => {
    const tsOnly = "<timestamp>Tuesday, Sep 15, 2026, 4:22 PM (UTC+8)</timestamp>";
    const protocol =
      `${tsOnly}\n\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.</user_query>`;
    const long =
      "I6 **没有整列车绿**。本地 `--force-build-all` 编出来的 aioncore / finclaw / finsafe 已用上，但 **`FINCLAW_FROM_PATH=finclaw/target/release` 这条路径冷启失败**。";
    const summary =
      "I6 **没有整列车绿**，但 plat-arch 路径上映像/开关沙箱已经能测出来。\n\n本地 `--force-build-all` 编出的三件套是齐的。直接用 `finclaw/target/release` 冷启会 502（finsafe 把整棵 cargo `release/` 当 plat-arch 拷贝，mux 20s 内起不来）。改成 **同一 SHA** 的 `bundled-finclaw/win32-x64` 后：\n\n- 沙箱开：映像在 `sandbox-images\\94eacac…\\finclaw.exe`，安装树 icacls 没新增 ACE，没有 `WRITE_DAC` / eager fallback\n- 关沙箱：映像回到 bundled 安装树\n- 再开：又回到 staging 副本\n- **p95 < 10s 未过**（冷启 12.3s / 再开 15.1s）\n- 短聊发了 202，50s 内没有助手回复，**不能算「能聊」**\n\npin 没 bump，不要把这次说成沙箱列车完成。";
    const userLine = (seq: number, text: string) => ev({
      seq, source: "transcript",
      payload: JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } }),
    });
    const asstLine = (seq: number, text: string) => ev({
      seq, source: "transcript",
      payload: JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } }),
    });
    const protocolBlock = (start: number) => [
      ...Array.from({ length: 7 }, (_, i) => userLine(start + i, tsOnly)),
      userLine(start + 7, protocol),
      asstLine(start + 8, summary),
    ];
    const blocks = eventsToChat([
      asstLine(276, long),
      ev({ seq: 277, source: "transcript", payload: JSON.stringify({ type: "turn_ended", status: "success" }) }),
      ...protocolBlock(279),
      ...protocolBlock(288),
      ev({ seq: 297, source: "transcript", payload: JSON.stringify({ type: "turn_ended", status: "success" }) }),
    ]);
    const asst = blocks.filter((b) => b.kind === "assistant");
    expect(asst.map((b) => b.kind === "assistant" ? b.text : "")).toEqual([long, summary]);
    expect(asst[1]).toMatchObject({ kind: "assistant", seq: 287 });
    expect(blocks.filter((b) => b.kind === "user")).toEqual([]);
  });

  test("jsonl A/B/A/B replay after turn_ended is one pair (r-c56e8162 seq 191-223)", () => {
    const status = "把剩余设计收成一份完整规格：触发/失败路径一并写死，只把必须你拍板或动手的运维项单独列出来。";
    const body =
      "完整方案已经写成实施基准，并推到 `armada` 的 `origin/master`：\n\n[`docs/superpowers/specs/2026-09-16-armada-app-push-design.md`](armada/docs/superpowers/specs/2026-09-16-armada-app-push-design.md)";
    const asst = (seq: number, text: string) => ev({
      seq, source: "transcript",
      payload: JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } }),
    });
    const tool = (seq: number) => ev({
      seq, source: "transcript",
      payload: JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { path: "/ws/spec.md" } }] },
      }),
    });
    const ended = (seq: number) => ev({
      seq, source: "transcript", payload: JSON.stringify({ type: "turn_ended", status: "success" }),
    });
    const replay = (start: number) => [
      tool(start), asst(start + 1, status), tool(start + 2), asst(start + 3, body), ended(start + 4),
    ];
    const blocks = eventsToChat([
      ev({ seq: 124, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n继续\n</user_query>" }] },
      }) }),
      ...replay(190),
      ...replay(202),
      ...replay(214),
    ]);
    const assts = blocks.filter((b) => b.kind === "assistant");
    expect(assts.map((b) => b.kind === "assistant" ? b.text : "")).toEqual([body]);
    expect(assts[0]).toMatchObject({ kind: "assistant", seq: 193 });
    expect(assistantBodyForPrompt(blocks, "继续")).toBe(body);
  });

  test("same assistant text in two operator turns stays two bubbles", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n第一次\n</user_query>" }] },
      }) }),
      ev({ seq: 2, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "一样的回复" }] },
      }) }),
      ev({ seq: 3, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n再问一次\n</user_query>" }] },
      }) }),
      ev({ seq: 4, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "一样的回复" }] },
      }) }),
    ]);
    expect(blocks.filter((b) => b.kind === "assistant")).toHaveLength(2);
  });

  test("Cursor scope-done protocol user_query is not an operator bubble (r-4510dd36 seq 3685)", () => {
    const blocks = eventsToChat([
      ev({ seq: 3677, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n怎么还有团队的事？\n</user_query>" }] },
      }) }),
      ev({ seq: 3679, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "FinDesk 没有团队产品面。" }] },
      }) }),
      ev({ seq: 3681, source: "transcript", payload: JSON.stringify({ type: "turn_ended", status: "success" }) }),
      ev({ seq: 3685, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.</user_query>" }] },
      }) }),
      ev({ seq: 3686, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "那次 aionui-sidebar 测试是 47 过、1 失败。" }] },
      }) }),
    ]);
    expect(blocks.filter((b) => b.kind === "user")).toEqual([
      { kind: "user", text: "怎么还有团队的事？", seq: 3677 },
    ]);
    expect(assistantBodyText(blocks)).toContain("47 过、1 失败");
  });

  test("Cursor plan-mode protocol user_query is not a operator bubble (r-0f0eadc6 seq 2358)", () => {
    const blocks = eventsToChat([
      ev({ seq: 2300, source: "transcript", payload: JSON.stringify({
        role: "user", message: { content: [{ type: "text", text: "<user_query>\n先处理已经review出来的内容的问题\n</user_query>" }] },
      }) }),
      ev({ seq: 2301, source: "transcript", payload: JSON.stringify({
        role: "assistant", message: { content: [{ type: "text", text: "先写计划。" }] },
      }) }),
      ev({ seq: 2358, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({
        prompt: "Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.\n\nTo-do's from the plan:\n1. Fix extraUsers",
      }) }),
    ]);
    expect(blocks.filter((b) => b.kind === "user")).toEqual([
      { kind: "user", text: "先处理已经review出来的内容的问题", seq: 2300 },
    ]);
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
    const childCid = "a7bcf55d-baaa-41fb-95ec-e4b600bc9773";
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
      ev({ seq: 3, hook_event_name: "subagentStart", payload: JSON.stringify({
        subagent_id: "call-web", conversation_id: childCid, task: webTask,
      }) }),
      ev({ seq: 10, source: "subagent-transcript", payload: JSON.stringify({
        __subagent_cid: childCid,
        role: "user",
        message: { content: [{ type: "text", text: `<user_query>\n${webTask}\n</user_query>` }] },
      }) }),
      ev({ seq: 11, source: "subagent-transcript", payload: JSON.stringify({
        __subagent_cid: childCid,
        role: "assistant",
        message: { content: [{ type: "text", text: "Let me start by reading the diff." }] },
      }) }),
      ev({ seq: 12, source: "subagent-transcript", payload: JSON.stringify({
        __subagent_cid: childCid,
        role: "assistant",
        message: { content: [{ type: "text", text: review }] },
      }) }),
    ]);
    expect(assistantBodyText(blocks)).toBe("");
    expect(blocks).toContainEqual({ kind: "thought", text: "先拉审查。", seq: 2 });
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

  test("without cid, child jsonl does not attach by matching task text", () => {
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
      ev({ seq: 12, source: "subagent-transcript", payload: JSON.stringify({
        __subagent_cid: "a7bcf55d-baaa-41fb-95ec-e4b600bc9773",
        role: "assistant",
        message: { content: [{ type: "text", text: review }] },
      }) }),
    ]);
    expect(assistantBodyText(blocks)).toBe("");
    const subs = blocks.filter((b) => b.kind === "subagent");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ kind: "subagent", title: "Kimi web branch review" });
    expect(subs[0].kind === "subagent" && subs[0].text).toBeUndefined();
    expect(subs[0].kind === "subagent" && subs[0].cid).toBeUndefined();
  });
});

describe("segmentChat", () => {
  const thought = (seq: number, text: string): ChatBlock => ({ kind: "thought", seq, text });
  const user = (seq: number, text: string): ChatBlock => ({ kind: "user", seq, text });
  const asst = (seq: number, text: string): ChatBlock => ({ kind: "assistant", seq, text });
  const tool = (seq: number, name: string): ChatBlock => ({ kind: "tool", seq, name, summary: name });

  test("folds thoughts and tools before the assistant reply (Cursor process fold)", () => {
    const segs = segmentChat([user(1, "hi"), thought(2, "先想"), tool(3, "Shell")]);
    expect(segs.map((s) => s.kind)).toEqual(["user", "process"]);
    const proc = segs[1];
    expect(proc.kind).toBe("process");
    if (proc.kind !== "process") return;
    expect(proc.steps.map((s) => s.kind)).toEqual(["thought", "tool"]);
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

  test("completed turn folds; live follow-up turn also folds", () => {
    const segs = segmentChat([
      user(1, "a"), thought(2, "t1"), asst(3, "done"),
      user(4, "b"), thought(5, "t2"), tool(6, "Read"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["user", "process", "assistant", "user", "process"]);
  });

  test("assistantBodyText joins assistant replies and skips process", () => {
    expect(assistantBodyText([
      user(1, "hi"), thought(2, "想"), asst(3, "先改。"), asst(4, "好了。"),
    ])).toBe("先改。\n\n好了。");
    expect(assistantBodyText([user(1, "hi")])).toBe("");
  });

  test("assistantBodyForPrompt keeps only the matching turn", () => {
    const blocks = [
      user(1, "更早的任务"), thought(2, "想"), asst(3, "那是旧回复。"),
      user(4, "那时还没修好？"), asst(5, "现在修好了。"),
    ];
    expect(assistantBodyText(blocks)).toContain("旧回复");
    expect(assistantBodyForPrompt(blocks, "那时还没修好？")).toBe("现在修好了。");
    expect(assistantBodyForPrompt(blocks, "未知 prompt")).toBe("现在修好了。");
  });

  test("assistantBodyForPrompt does not give App an older turn via startsWith", () => {
    const blocks = [
      user(1, "请帮我看一下这个 PR 的全部改动"), asst(2, "上一折长文。"),
      user(3, "再改一处"), asst(4, "当前折。"),
    ];
    expect(assistantBodyForPrompt(blocks, "请帮我看")).toBe("当前折。");
  });

  test("lastTurnAssistantBody ignores prompt match and keeps the last turn", () => {
    const blocks = [
      user(1, "更早的任务"), asst(2, "那是旧回复。"),
      user(3, "那时还没修好？"), asst(4, "现在修好了。"),
    ];
    expect(lastTurnAssistantBody(blocks)).toBe("现在修好了。");
    expect(assistantBodyForPrompt(blocks, "更早的任务")).toBe("那是旧回复。");
  });
});

describe("Cursor generation rendering", () => {
  const protocol =
    "<timestamp>Thursday, Sep 17, 2026, 9:52 AM (UTC+8)</timestamp>\n\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.</user_query>";
  const asst = (seq: number, text: string, tools: string[] = []) => ev({
    seq, source: "transcript",
    payload: JSON.stringify({
      role: "assistant",
      message: {
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...tools.map((name) => ({ type: "tool_use", name, input: { path: "/ws/a.txt" } })),
        ],
      },
    }),
  });
  const ended = (seq: number) => ev({
    seq, source: "transcript", payload: JSON.stringify({ type: "turn_ended", status: "success" }),
  });
  const userLine = (seq: number, text: string) => ev({
    seq, source: "transcript",
    payload: JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } }),
  });

  test("text on the same jsonl line as tool_use is process, not an assistant bubble", () => {
    const blocks = eventsToChat([
      userLine(1, "<user_query>\n改 hello.txt\n</user_query>"),
      asst(2, "先改文件。", ["StrReplace"]),
      asst(3, "ok"),
      ended(4),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "thought", "tool", "assistant"]);
    expect(blocks[1]).toMatchObject({ kind: "thought", text: "先改文件。", seq: 2 });
    expect(blocks[3]).toMatchObject({ kind: "assistant", text: "ok", seq: 3 });
  });

  test("r-98c03be6: protocol Briefly-inform generations fold; keep first-turn body and last status", () => {
    const table = "**当时没有。** 上一轮只跑了任务板单测就推了，没走 `--force-build`。\n\n| 项 | 结果 |\n|---|---|\n| cargo | 过了 |";
    const last = "`--force-build` 拉起的 FDE 已停掉（进程 aborted，跑了约 42 分钟）。";
    const blocks = eventsToChat([
      userLine(1, "<user_query>\nForce build验证过了吗\n</user_query>"),
      asst(2, "没有。我先查入口。", ["Grep"]),
      asst(3, table),
      ended(4),
      userLine(5, protocol),
      asst(6, "后台 force-build 还在刷日志，我先看最新。", ["Grep"]),
      asst(7, "还是 FDE 运行中的 `error:` 噪声，不是 force-build 挂了。"),
      ended(8),
      userLine(9, protocol),
      asst(10, last),
      ended(11),
    ]);
    const assts = blocks.filter((b) => b.kind === "assistant");
    expect(assts.map((b) => b.kind === "assistant" ? b.text : "")).toEqual([table, last]);
    expect(blocks.filter((b) => b.kind === "user")).toEqual([
      { kind: "user", text: "Force build验证过了吗", seq: 1 },
    ]);
    expect(assistantBodyForPrompt(blocks, "Force build验证过了吗")).toBe(`${table}\n\n${last}`);
    const segs = segmentChat(blocks);
    expect(segs.filter((s) => s.kind === "assistant")).toHaveLength(2);
    expect(segs.filter((s) => s.kind === "process").length).toBeGreaterThan(0);
  });
});

describe("AskQuestion chat blocks", () => {
  test("jsonl AskQuestion is kind=ask not tool, and is not a user bubble", () => {
    const blocks = eventsToChat([
      ev({ seq: 1, source: "transcript", payload: JSON.stringify({
        role: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "AskQuestion",
            id: "tool-ask-1",
            input: {
              questions: [{
                id: "q0",
                prompt: "选一个",
                options: [
                  { id: "theme", label: "主题" },
                  { id: "workspace", label: "工作区" },
                ],
              }],
            },
          }],
        },
      }) }),
    ]);
    expect(blocks.some((b) => b.kind === "user")).toBe(false);
    expect(blocks.filter((b) => b.kind === "tool")).toEqual([]);
    expect(blocks).toMatchObject([{
      kind: "ask", request_id: "tool-ask-1", prompt: "选一个", action: "resolved",
    }]);
    expect(blocks[0].kind === "ask" && blocks[0].options).toHaveLength(2);
    const segs = segmentChat(blocks);
    expect(segs.some((s) => s.kind === "process")).toBe(false);
    expect(segs[0]).toMatchObject({ kind: "ask" });
  });

  test("cdp askQuestion event is pending; resolved does not emitUser", () => {
    const blocks = eventsToChat([
      ev({
        seq: 1, source: "cdp", hook_event_name: "askQuestion",
        payload: JSON.stringify({
          request_id: "ask-1",
          questions: [{ id: "q0", prompt: "选一个", options: [{ id: "a", label: "A", text: "甲" }] }],
        }),
      }),
      ev({
        seq: 2, source: "cdp", hook_event_name: "askQuestionResolved",
        payload: JSON.stringify({ request_id: "ask-1", via: "cdp" }),
      }),
    ]);
    expect(blocks.some((b) => b.kind === "user")).toBe(false);
    expect(blocks).toMatchObject([{ kind: "ask", request_id: "ask-1", prompt: "选一个", action: "resolved" }]);
  });
});

describe("mergePendingAsk / ask identity is request_id", () => {
  const opt = { id: "a", label: "A", text: "甲" };

  test("same prompt different request_id does not replace the existing card", () => {
    const blocks: ChatBlock[] = [{
      kind: "ask", seq: 1, request_id: "old-id", prompt: "选一个", options: [opt], action: "pending",
    }];
    const next = mergePendingAsk(blocks, {
      request_id: "new-id",
      questions: [{ prompt: "选一个", options: [opt] }],
    });
    const asks = next.filter((b) => b.kind === "ask");
    expect(asks).toHaveLength(2);
    expect(asks.map((b) => b.kind === "ask" ? b.request_id : "")).toEqual(["old-id", "new-id"]);
  });

  test("same request_id still replaces even if prompt changed", () => {
    const blocks: ChatBlock[] = [{
      kind: "ask", seq: 1, request_id: "ask-1", prompt: "短问", options: [opt], action: "pending",
    }];
    const next = mergePendingAsk(blocks, {
      request_id: "ask-1",
      questions: [{ prompt: "更长的问题", options: [opt] }],
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ kind: "ask", request_id: "ask-1", prompt: "更长的问题" });
  });

  test("askQuestion without request_id synthesizes ask-hook-<seq> at the producer", () => {
    const blocks = eventsToChat([
      ev({
        seq: 7, source: "cdp", hook_event_name: "askQuestion",
        payload: JSON.stringify({
          questions: [{ id: "q0", prompt: "选一个", options: [opt] }],
        }),
      }),
    ]);
    expect(blocks).toMatchObject([{ kind: "ask", request_id: "ask-hook-7", prompt: "选一个", action: "pending" }]);
  });

  test("dedupe does not collapse two asks that only share a prompt", () => {
    const q = { id: "q0", prompt: "选一个", options: [opt] };
    const blocks = eventsToChat([
      ev({
        seq: 1, source: "cdp", hook_event_name: "askQuestion",
        payload: JSON.stringify({ request_id: "ask-a", questions: [q] }),
      }),
      ev({
        seq: 2, source: "cdp", hook_event_name: "askQuestion",
        payload: JSON.stringify({ request_id: "ask-b", questions: [q] }),
      }),
    ]);
    expect(blocks.filter((b) => b.kind === "ask").map((b) => b.kind === "ask" ? b.request_id : "")).toEqual([
      "ask-a", "ask-b",
    ]);
  });
});

describe("mergePendingAsk kind + continueAllowed", () => {
  test("copies hub kind=plan and hides continue on two questions", () => {
    const plan = mergePendingAsk([], {
      request_id: "p1",
      kind: "plan",
      questions: [{ prompt: "Created Plan", options: [{ id: "go", label: "Go", text: "x" }] }],
    });
    expect(plan[0]).toMatchObject({ kind: "ask", askKind: "plan", continueAllowed: true });
    const two = mergePendingAsk([], {
      request_id: "a1",
      questions: [
        { prompt: "q1", options: [{ id: "a", label: "A", text: "a" }] },
        { prompt: "q2", options: [{ id: "b", label: "B", text: "b" }] },
      ],
    });
    expect(two[0]).toMatchObject({ continueAllowed: true });
    const multi = mergePendingAsk([], {
      request_id: "a2",
      questions: [{ prompt: "q", allow_multiple: true, options: [{ id: "a", label: "A", text: "a" }] }],
    });
    expect(multi[0]).toMatchObject({ continueAllowed: false });
    const collided = mergePendingAsk([], {
      request_id: "a4",
      questions: [{
        prompt: "Questions",
        options: [
          { id: "a", label: "A", text: "第一题" },
          { id: "a", label: "A", text: "第二题" },
        ],
      }],
    });
    expect(collided[0]).toMatchObject({ continueAllowed: false });
    const buildNoKind = mergePendingAsk([], {
      request_id: "a3",
      questions: [{ prompt: "q", options: [{ id: "build", label: "Build", text: "Build" }] }],
    });
    expect(buildNoKind[0]).toMatchObject({ continueAllowed: true });
    expect(buildNoKind[0].kind === "ask" && buildNoKind[0].askKind).toBeUndefined();
  });
});

describe("recentTurnsWindow", () => {
  const turns = (n: number): ChatBlock[] => {
    const out: ChatBlock[] = [];
    for (let i = 1; i <= n; i++) {
      out.push({ kind: "user", text: `u${i}`, seq: i * 2 - 1 });
      out.push({ kind: "assistant", text: `a${i}`, seq: i * 2 });
    }
    return out;
  };

  test("first paint keeps the last 3 turns and hides the prefix", () => {
    expect(INITIAL_VISIBLE_TURNS).toBe(3);
    const blocks = turns(5);
    expect(initialHiddenPrefixTurns(blocks)).toBe(2);
    const visible = recentTurnsWindow(blocks, 2);
    expect(visible.map((b) => b.kind === "user" || b.kind === "assistant" ? b.text : "")).toEqual([
      "u3", "a3", "u4", "a4", "u5", "a5",
    ]);
  });

  test("hiddenPrefix 0 shows the full window after scrolling up", () => {
    const blocks = turns(4);
    expect(recentTurnsWindow(blocks, 0).map((b) => b.kind === "user" ? b.text : "").filter(Boolean)).toEqual([
      "u1", "u2", "u3", "u4",
    ]);
  });

  test("fewer than 3 turns shows everything", () => {
    const blocks = turns(2);
    expect(initialHiddenPrefixTurns(blocks)).toBe(0);
    expect(recentTurnsWindow(blocks, 0)).toEqual(blocks);
  });
});

describe("mergeOutboundChat / queuedOutbound", () => {
  test("queue injecting and queued go to tray; steered becomes optimistic user", () => {
    const blocks: ChatBlock[] = [{ kind: "user", text: "旧问题", seq: 1 }];
    const outbound = [
      { id: "o1", prompt: "排队", expected_mode: "queue", state: "queued", created_at: 1 },
      { id: "o2", prompt: "直发", expected_mode: "steer", state: "steered", created_at: 2 },
    ];
    expect(queuedOutbound(outbound).map((o) => o.prompt)).toEqual(["排队"]);
    expect(mergeOutboundChat(blocks, outbound).map((b) => `${b.kind}:${"text" in b ? b.text : ""}`)).toEqual([
      "user:旧问题",
      "user:直发",
    ]);
  });
  test("same text already in transcript is not duplicated", () => {
    const blocks: ChatBlock[] = [{ kind: "user", text: "直发", seq: 1 }];
    const outbound = [
      { id: "o2", prompt: "直发", expected_mode: "steer", state: "steered", created_at: 2 },
    ];
    expect(mergeOutboundChat(blocks, outbound)).toEqual(blocks);
  });
});

describe("collapseRepeatedTools", () => {
  const read = (seq: number, file = "552282.txt"): ChatBlock => ({
    kind: "tool", seq, name: "Read", summary: `Read · ${file}`,
  });

  test("r-3a334fe3: consecutive Read of the same file collapse to × N", () => {
    const got = collapseRepeatedTools([read(1), read(2), read(3)]);
    expect(got).toEqual([
      { kind: "tool", seq: 1, name: "Read", summary: "Read · 552282.txt", count: 3 },
    ]);
  });

  test("different files or a thought in between do not merge", () => {
    const got = collapseRepeatedTools([
      read(1, "a.txt"),
      read(2, "b.txt"),
      { kind: "thought", seq: 3, text: "再看" },
      read(4, "a.txt"),
    ]);
    expect(got.filter((b) => b.kind === "tool")).toHaveLength(3);
    expect(got.some((b) => b.kind === "tool" && "count" in b && b.count)).toBe(false);
  });

  test("eventsToChat merges live hook Reads of the same path", () => {
    const evs = [1, 2, 3].map((seq) => ev({
      seq,
      source: "hook",
      hook_event_name: "preToolUse",
      payload: JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/Users/apple/.cursor/projects/Users-apple-Desktop-desk/terminals/552282.txt" },
      }),
    }));
    const blocks = eventsToChat(evs);
    expect(blocks).toEqual([
      { kind: "tool", name: "Read", summary: "Read · 552282.txt", seq: 1, count: 3 },
    ]);
  });

  test("processFoldLabel shows last tool and × N like Cursor's compact row", () => {
    expect(processFoldLabel([
      { kind: "thought", seq: 1, text: "等编译" },
      { kind: "tool", seq: 2, name: "Read", summary: "Read · 552282.txt", count: 1250 },
    ])).toBe("思考过程 · Read · 552282.txt × 1250");
    expect(processFoldLabel([{ kind: "thought", seq: 1, text: "想" }])).toBe("思考过程 · 1 步");
  });
});

describe("userMessageCaption", () => {
  test("strips [图片] when thumbs will render", () => {
    expect(userMessageCaption("[图片]", ["abc"])).toBe("");
    expect(userMessageCaption("[2 张图片]", ["a", "b"])).toBe("");
    expect(userMessageCaption("[图片] 看这张", ["abc"])).toBe("看这张");
  });

  test("keeps [图片] when there are no blob ids", () => {
    expect(userMessageCaption("[图片]")).toBe("[图片]");
    expect(userMessageCaption("[图片] 看这张")).toBe("[图片] 看这张");
  });
});

describe("stampFallbackImageIds", () => {
  test("stamps run attachments onto the only [图片] user bubble", () => {
    const blocks = stampFallbackImageIds(
      [{ kind: "user", text: "[图片] 看图", seq: 1 }, { kind: "assistant", text: "ok", seq: 2 }],
      ["abc"],
    );
    expect(blocks[0]).toEqual({ kind: "user", text: "[图片] 看图", seq: 1, imageIds: ["abc"] });
  });

  test("does not stamp when the bubble already has ids", () => {
    const blocks = stampFallbackImageIds(
      [{ kind: "user", text: "[图片]", seq: 1, imageIds: ["keep"] }],
      ["other"],
    );
    expect(blocks[0]).toEqual({ kind: "user", text: "[图片]", seq: 1, imageIds: ["keep"] });
  });
});
