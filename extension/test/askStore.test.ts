import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { askPollMany } from "../src/askDetect";
import {
  asksFromComposerRows,
  cursorStateDbPath,
  extraBubbleIds,
  inspectStoredBubbles,
  mergeVisibleAndStoredAsks,
  newestBubbleIds,
  RECENT_BUBBLE_SQL,
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

  test("a pending ask flushed before the header list is still reported", async () => {
    const flushed = {
      toolFormerData: {
        name: "ask_question",
        status: "completed",
        additionalData: { status: "pending" },
        params: JSON.stringify({
          title: "确认四处修复口径",
          questions: [{
            id: "memory_policy",
            prompt: "记忆策略按哪条做？",
            options: [
              { id: "explicit_only", label: "只记明确说的" },
              { id: "habit_too", label: "习惯也记" },
            ],
          }],
        }),
      },
    };
    const composerRaw = JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "old" }] });
    const bubbles = new Map<string, string>([
      ["old", JSON.stringify({ toolFormerData: { name: "Shell" } })],
      ["ask-new", JSON.stringify(flushed)],
    ]);
    const hit = asksFromComposerRows("cid-1", composerRaw, bubbles, ["ask-new", "old"]);
    expect(hit.state).toBe("pending");
    if (hit.state !== "pending") return;
    expect(hit.inspect.prompt).toBe("记忆策略按哪条做？");
    const merged = mergeVisibleAndStoredAsks({ present: false }, [hit]);
    const acts = askPollMany(
      new Map([["r-1", { conversationId: "cid-1" }]]),
      new Map(),
      merged.presents,
      merged.submittedCids,
      () => "ask-1",
    );
    expect(acts.map((a) => a.type)).toEqual(["askQuestion"]);
  });

  test("header ids stay the tail; a newer unlisted bubble is appended after them", () => {
    const header = ["old", "kept"];
    expect(extraBubbleIds(header, ["ask-new", "kept", "old"])).toEqual(["ask-new"]);
    expect(tailBubbleIds({
      fullConversationHeadersOnly: [{ bubbleId: "kept" }, { bubbleId: "also" }],
    })).toEqual(["kept", "also"]);
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

  test("newest bubble ids follow rowid, not UUID key order", () => {
    const prefix = "bubbleId:cid-1:";
    const ids = newestBubbleIds([
      { key: `${prefix}zzz-old`, rid: 1 },
      { key: `${prefix}aaa-new`, rid: 50 },
      { key: `${prefix}mmm`, rid: 20 },
      { key: "other:1", rid: 99 },
    ], prefix, 2);
    expect(ids).toEqual(["aaa-new", "mmm"]);
  });

  test("recent bubble lookup uses the key index and does not sort the whole table by rowid", () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-ask-scan-"));
    const db = new Database(join(dir, "state.vscdb"));
    db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const ins = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    const cid = "cid-1";
    const start = `bubbleId:${cid}:`;
    const end = `bubbleId:${cid};`;
    const tx = db.transaction(() => {
      for (let i = 0; i < 12; i++) ins.run(`${start}m${String(i).padStart(2, "0")}`, "x");
      ins.run(`${start}aaa-new`, "ask");
      for (let i = 0; i < 4000; i++) ins.run(`composerData:other-${i}`, "y");
    });
    tx();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${RECENT_BUBBLE_SQL}`).all(start, end) as { detail: string }[];
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
    expect(plan.some((row) => row.detail.includes("sqlite_autoindex_cursorDiskKV_1"))).toBe(true);
    const rows = db.prepare(RECENT_BUBBLE_SQL).all(start, end) as { key: string; rid: number }[];
    expect(newestBubbleIds(rows, start)[0]).toBe("aaa-new");
    db.close();
  });
});
