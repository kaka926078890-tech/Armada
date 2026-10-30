import { describe, expect, test } from "bun:test";
import { askPollMany } from "../src/askDetect";
import {
  cursorStateDbPath,
  inspectStoredBubbles,
  mergeVisibleAndStoredAsks,
  tailBubbleIds,
} from "../src/askStore";

const pending = {
  toolFormerData: {
    name: "ask_question",
    status: "completed",
    toolCallId: "toolu_01449j1yxeXdZkpgDrJyV6Gi",
    additionalData: { status: "pending" },
    rawArgs: JSON.stringify({
      questions: [
        {
          id: "scope",
          prompt: "分类规则收紧到什么程度？",
          options: [
            { id: "class", label: "整类修：去掉「请用」" },
            { id: "narrow", label: "只去掉「请用」" },
          ],
        },
        {
          id: "cleanup",
          prompt: "旧数据怎么办？",
          options: [
            { id: "report", label: "先修代码" },
            { id: "code", label: "只修代码" },
          ],
        },
      ],
    }),
  },
};

describe("stored ask", () => {
  test("darwin and win32 paths, and no path on other platforms", () => {
    expect(cursorStateDbPath("/Users/a", "darwin")).toBe(
      "/Users/a/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
    expect(cursorStateDbPath("C:/Users/a", "win32")?.replaceAll("\\", "/")).toBe(
      "C:/Users/a/AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
    );
    expect(cursorStateDbPath("/home/a", "linux")).toBeNull();
  });

  test("a pending ask in the header tail becomes letter options plus Other", () => {
    const hit = inspectStoredBubbles("cid-1", [pending]);
    expect(hit.state).toBe("pending");
    if (hit.state !== "pending") return;
    expect(hit.inspect.questions).toEqual([
      {
        id: "q0",
        prompt: "分类规则收紧到什么程度？",
        options: [
          { id: "a", label: "A", text: "整类修：去掉「请用」" },
          { id: "b", label: "B", text: "只去掉「请用」" },
          { id: "c", label: "C", text: "Other...", freeform: true },
        ],
      },
      {
        id: "q1",
        prompt: "旧数据怎么办？",
        options: [
          { id: "a", label: "A", text: "先修代码" },
          { id: "b", label: "B", text: "只修代码" },
          { id: "c", label: "C", text: "Other...", freeform: true },
        ],
      },
    ]);
  });

  test("a pending row that is not in the header list is ignored", () => {
    const ids = tailBubbleIds({
      fullConversationHeadersOnly: [{ bubbleId: "kept" }, { bubbleId: "also" }],
    });
    expect(ids).toEqual(["kept", "also"]);
    expect(tailBubbleIds({
      fullConversationHeadersOnly: Array.from({ length: 41 }, (_, i) => ({ bubbleId: `b${i}` })),
    })[0]).toBe("b1");
  });

  test("a stored question is pending before the chat marks it pending", () => {
    const early = {
      toolFormerData: {
        name: "ask_question",
        status: "loading",
        additionalData: null,
        rawArgs: JSON.stringify({
          questions: [{
            id: "market-source",
            prompt: "行情终端按哪条数据来源做？",
            options: [
              { id: "plus", label: "对齐 Plus" },
              { id: "tushare", label: "只用 Tushare" },
            ],
          }],
        }),
      },
    };
    const hit = inspectStoredBubbles("cid-1", [early]);
    expect(hit.state).toBe("pending");
    if (hit.state !== "pending") return;
    expect(hit.inspect.prompt).toBe("行情终端按哪条数据来源做？");
    expect(hit.inspect.options.map((o) => o.label)).toEqual(["A", "B", "C"]);
  });

  test("params carry the question when rawArgs is empty", () => {
    const early = {
      toolFormerData: {
        name: "ask_question",
        status: "loading",
        additionalData: { status: "loading" },
        rawArgs: null,
        params: JSON.stringify({
          questions: [{
            id: "parse-scope",
            prompt: "上传资料这一项先解析哪些文件？",
            options: [
              { id: "text", label: "先做纯文本" },
              { id: "office", label: "连 PDF 一起解析" },
            ],
          }],
        }),
      },
    };
    const hit = inspectStoredBubbles("cid-1", [early]);
    expect(hit.state).toBe("pending");
    if (hit.state !== "pending") return;
    expect(hit.inspect.prompt).toBe("上传资料这一项先解析哪些文件？");
  });

  test("latest submitted ask is not pending, and loading holds", () => {
    const submitted = {
      toolFormerData: { ...pending.toolFormerData, additionalData: { status: "submitted" } },
    };
    expect(inspectStoredBubbles("cid-1", [pending, submitted]).state).toBe("submitted");
    const loading = { toolFormerData: { name: "ask_question", status: "loading", additionalData: null, rawArgs: "" } };
    expect(inspectStoredBubbles("cid-1", [loading]).state).toBe("loading");
    expect(inspectStoredBubbles("cid-1", [{ toolFormerData: { name: "Shell" } }]).state).toBe("none");
  });

  test("an off-screen pending ask is reported, and the on-screen one is not doubled", () => {
    const off = inspectStoredBubbles("cid-off", [pending]);
    const on = inspectStoredBubbles("cid-on", [pending]);
    if (off.state !== "pending" || on.state !== "pending") throw new Error("fixture");
    const merged = mergeVisibleAndStoredAsks(
      { present: true, prompt: "屏上", conversation_id: "cid-on", options: [{ id: "a", label: "A", text: "甲" }] },
      [on, off],
    );
    expect(merged.presents.map((p) => p.conversation_id)).toEqual(["cid-on", "cid-off"]);
    expect(merged.presents[0]?.prompt).toBe("屏上");
    const bound = new Map([["r-on", { conversationId: "cid-on" }], ["r-off", { conversationId: "cid-off" }]]);
    const acts = askPollMany(bound, new Map(), merged.presents, [], (id) => `ask-${id}`);
    expect(acts.map((a) => a.type === "askQuestion" ? a.runId : "")).toEqual(["r-on", "r-off"]);
  });

  test("submitted clears the card; loading does not; three visible misses still do", () => {
    const bound = new Map([["r-1", { conversationId: "cid-1" }]]);
    const prev = new Map([["r-1", "ask-1"]]);
    expect(askPollMany(bound, prev, [], ["cid-1"], () => "x")).toEqual([
      { type: "askQuestionResolved", runId: "r-1", request_id: "ask-1" },
    ]);
    expect(askPollMany(bound, prev, [], [], () => "x", 1, [], [], [], [], false, ["cid-1"])).toEqual([]);
    expect(askPollMany(bound, prev, [], [], () => "x", 1, [], [], [], [], true)).toEqual([
      { type: "askQuestionResolved", runId: "r-1", request_id: "ask-1" },
    ]);
  });
});
