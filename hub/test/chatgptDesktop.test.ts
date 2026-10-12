import { describe, expect, test } from "bun:test";
import {
  libraryAddReady,
  boardTargets,
  listWorkspaces,
  openWorkspace,
  planCodexMode,
  planAttach,
  matchRolloutTurn,
  planSend,
  planStop,
  readRollout,
  readTurn,
  rolloutCardText,
  type ChatgptControl,
} from "../src/chatgptDesktop";

/** 2026-10-12 这台 Mac 的侧栏。项目名来自「在 {name} 中…」按钮，对话标题不是工作区。 */
const sidebar: ChatgptControl[] = [
  { name: "项目", kind: "button", x: 64, y: 141, w: 254, h: 25 },
  { name: "armada-probe", kind: "button", x: 60, y: 172, w: 272, h: 30 },
  { name: "armada-probe 的项目操作", kind: "button", x: 332, y: 177, w: 20, h: 20 },
  { name: "在 armada-probe 中新建本地聊天", kind: "button", x: 340, y: 177, w: 20, h: 20 },
  { name: "Find probe-b-ping", kind: "button", x: 60, y: 203, w: 272, h: 30 },
  { name: "desk", kind: "button", x: 60, y: 234, w: 272, h: 30 },
  { name: "desk 的项目操作", kind: "button", x: 332, y: 239, w: 20, h: 20 },
  { name: "在 desk 中开始新聊天", kind: "button", x: 340, y: 239, w: 20, h: 20 },
  { name: "Probe a ping", kind: "button", x: 60, y: 265, w: 272, h: 30 },
  { name: "最近", kind: "button", x: 64, y: 478, w: 254, h: 25 },
  { name: "Find probe-normal-ping", kind: "button", x: 60, y: 509, w: 272, h: 30 },
];

/** 输入框项目菜单只有 desk，没有刚建的 armada-probe。不能拿它当工作区列表。 */
const projectMenu: ChatgptControl[] = [
  { name: "新建项目", kind: "button", x: 579, y: 706, w: 252, h: 28 },
  { name: "desk", kind: "button", x: 579, y: 669, w: 252, h: 29 },
  { name: "不在项目中工作", kind: "button", x: 579, y: 716, w: 252, h: 28 },
];

const composer: ChatgptControl[] = [
  { name: "使用 ChatGPT Work", kind: "textbox", x: 0, y: 0, w: 0, h: 0 },
  { name: "发送", kind: "button", x: 0, y: 0, w: 0, h: 0 },
  { name: "使用 ChatGPT Work", kind: "textbox", x: 414, y: 779, w: 712, h: 44 },
  { name: "发送", kind: "button", x: 1102, y: 827, w: 28, h: 28 },
  { name: "不在项目中工作", kind: "button", x: 0, y: 0, w: 0, h: 0 },
  { name: "不在项目中工作", kind: "button", x: 620, y: 274, w: 28, h: 28 },
];

describe("listWorkspaces", () => {
  test("sidebar is 最近 plus projects, not chat titles or the incomplete project menu", () => {
    expect(listWorkspaces(sidebar)).toEqual([
      { kind: "recent" },
      { kind: "project", name: "armada-probe" },
      { kind: "project", name: "desk" },
    ]);
    expect(listWorkspaces(projectMenu)).toEqual([]);
  });
});

describe("boardTargets", () => {
  test("dispatch lists 普通区 and projects, not 最近 or chat titles", () => {
    expect(boardTargets(sidebar)).toEqual([
      { root: "chatgpt:", label: "普通区" },
      { root: "chatgpt:armada-probe", label: "armada-probe" },
      { root: "chatgpt:desk", label: "desk" },
    ]);
  });
});

describe("planCodexMode", () => {
  test("a Codex composer does not open the mode menu", () => {
    const controls: ChatgptControl[] = [
      { name: "切换模式，当前模式：Codex", kind: "button", x: 62, y: 54, w: 108, h: 32 },
      { name: "随心输入", kind: "textbox", x: 568, y: 779, w: 712, h: 44 },
    ];
    expect(planCodexMode(controls)).toBeNull();
  });

  test("ChatGPT mode points at the mode button and the Codex menu item", () => {
    const controls: ChatgptControl[] = [
      { name: "切换模式，当前模式：ChatGPT", kind: "button", x: 62, y: 54, w: 108, h: 32 },
      { name: "询问 ChatGPT", kind: "textbox", x: 597, y: 823, w: 540, h: 36 },
    ];
    expect(planCodexMode(controls)).toEqual({
      pointer: { x: 116, y: 70 },
      item: "Codex 构建、调试和发布",
    });
  });
});

describe("openWorkspace", () => {
  test("project opens from the sidebar new-chat button, not the project name row", () => {
    expect(openWorkspace(sidebar, "desk")).toEqual({ type: "click", name: "在 desk 中开始新聊天" });
    expect(openWorkspace(sidebar, "armada-probe")).toEqual({
      type: "click",
      name: "在 armada-probe 中新建本地聊天",
    });
  });

  test("normal area clicks the visible 不在项目中工作, ignoring the zero-size copy", () => {
    expect(openWorkspace(composer, null)).toEqual({ type: "click", name: "不在项目中工作" });
  });
});

describe("planSend", () => {
  test("types into the visible composer and clicks the visible send button", () => {
    expect(planSend(composer, "probe-a-ping")).toEqual({
      focus: { name: "使用 ChatGPT Work", x: 444, y: 795 },
      text: "probe-a-ping",
      send: { x: 1116, y: 841 },
    });
  });
});

describe("planStop", () => {
  test("pointer-clicks the center of a visible enabled 停止 button", () => {
    const controls: ChatgptControl[] = [
      { name: "停止", kind: "button", x: 1102, y: 827, w: 28, h: 28 },
    ];
    expect(planStop(controls)).toEqual({ type: "pointer", x: 1116, y: 841 });
  });

  test("a disabled 停止 button is not a stop", () => {
    const controls: ChatgptControl[] = [
      { name: "停止", kind: "button", x: 1102, y: 827, w: 28, h: 28, disabled: true },
    ];
    expect(planStop(controls)).toEqual({ error: "not-ready" });
  });
});

describe("planAttach", () => {
  test("drops every file on the visible composer", () => {
    expect(planAttach(composer, [
      "/tmp/armada-probe-a.png",
      "/tmp/armada-probe-b.png",
      "/tmp/armada-probe-a.txt",
      "/tmp/armada-probe-b.txt",
    ])).toEqual({
      type: "drop",
      x: 770,
      y: 801,
      files: [
        "/tmp/armada-probe-a.png",
        "/tmp/armada-probe-b.png",
        "/tmp/armada-probe-a.txt",
        "/tmp/armada-probe-b.txt",
      ],
    });
  });
});

describe("libraryAddReady", () => {
  test("浏览全部 is the library picker; two selected rows can be added", () => {
    expect(libraryAddReady("从资料库添加 已选择 2 个 取消 添加到聊天")).toBe(2);
    expect(libraryAddReady("从资料库添加 搜索资料库")).toBe(0);
  });
});

/** 2026-10-12 切走之后仍写完的那条。全文在 task_complete.last_agent_message，不在可见页面。 */
const THREAD = "01a12ed8-13e1-7e91-b59b-0f48c0b150f4";
const TURN = "01a12ed9-cd13-7741-aa09-0d10f417de2c";
const USER = "请执行 python3 -c \"import time\\nfor i in range(1,20):\\n print(i, flush=True)\\n time.sleep(1)\" 标记 armada-bg-2";
const FINAL = "已执行完成，标记：`armada-bg-2`。\n\n输出为 `1` 到 `19`，进程退出码为 `0`。";

const userLine = JSON.stringify({
  type: "event_msg",
  payload: {
    type: "item_completed",
    thread_id: THREAD,
    turn_id: TURN,
    item: { type: "UserMessage", content: [{ type: "text", text: USER + "\n" }] },
  },
});

const completeLine = JSON.stringify({
  type: "event_msg",
  payload: {
    type: "task_complete",
    turn_id: TURN,
    last_agent_message: FINAL,
  },
});

describe("readRollout", () => {
  test("user line without task_complete is bound and not finished", () => {
    expect(readRollout(userLine)).toEqual([
      { threadId: THREAD, turnId: TURN, user: USER, assistant: null, completed: false, at: null },
    ]);
  });

  test("task_complete keeps the full last_agent_message for that turn", () => {
    expect(readRollout(`${userLine}\n${completeLine}`)).toEqual([
      { threadId: THREAD, turnId: TURN, user: USER, assistant: FINAL, completed: true, at: null },
    ]);
  });

  test("the dispatch prompt matches one turn, and two identical prompts match none", () => {
    const turns = readRollout(`${userLine}\n${completeLine}`);
    expect(matchRolloutTurn(turns, USER)).toEqual(turns[0]);
    expect(matchRolloutTurn(turns, USER + "\n")).toEqual(turns[0]);
    expect(matchRolloutTurn([...turns, { ...turns[0], turnId: "other" }], USER)).toBeNull();
  });

  test("a turn recorded before this dispatch is not this send", () => {
    const older = readRollout(JSON.stringify({
      timestamp: "2026-10-12T08:16:35.382Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "old-thread",
        turn_id: "old-turn",
        item: { type: "UserMessage", content: [{ type: "text", text: "你好\n" }] },
      },
    }) + "\n" + JSON.stringify({
      timestamp: "2026-10-12T08:16:54.091Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "old-turn", last_agent_message: "上一轮的回复" },
    }));
    const current = readRollout(JSON.stringify({
      timestamp: "2026-10-12T08:25:50.940Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "new-thread",
        turn_id: "new-turn",
        item: { type: "UserMessage", content: [{ type: "text", text: "你好\n" }] },
      },
    }));
    const notBefore = Date.parse("2026-10-12T08:25:45.513Z");
    expect(matchRolloutTurn(older, "你好", notBefore)).toBeNull();
    expect(matchRolloutTurn([...older, ...current], "你好", notBefore)?.turnId).toBe("new-turn");
  });
});

describe("rolloutCardText", () => {
  test("a finished background turn is the card's full reply", () => {
    const [turn] = readRollout(`${userLine}\n${completeLine}`);
    expect(rolloutCardText(turn)).toBe(FINAL);
  });

  test("an unfinished turn has no card reply yet", () => {
    const [turn] = readRollout(userLine);
    expect(rolloutCardText(turn)).toBeNull();
  });
});

describe("planSend while generating", () => {
  test("clicks 排队, not 发送, while the turn is still running", () => {
    const controls: ChatgptControl[] = [
      { name: "与 Codex 协作", kind: "textbox", x: 414, y: 779, w: 712, h: 44 },
      { name: "停止", kind: "button", x: 1070, y: 827, w: 28, h: 28 },
      { name: "排队", kind: "button", x: 1102, y: 827, w: 28, h: 28 },
    ];
    expect(planSend(controls, "armada-queue-b").send).toEqual({ x: 1116, y: 841 });
  });
});

describe("readTurn", () => {
  test("reads 你说 and ChatGPT 说, and treats 停止了 as stopped", () => {
    expect(readTurn("你说：\nprobe-a-ping\n10:36\nChatGPT 说：\nhello")).toEqual({
      user: "probe-a-ping",
      assistant: "hello",
      stopped: false,
    });
    expect(readTurn("请写一首八十行的诗\n你在 0秒 后停止了\n雨从灰色的云底垂下来").stopped).toBe(true);
    expect(readTurn("田野里的麦穗弯下腰，向看不见的").stopped).toBe(false);
  });
});
