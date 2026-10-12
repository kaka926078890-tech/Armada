import { describe, expect, test } from "bun:test";
import {
  libraryAddReady,
  listWorkspaces,
  openWorkspace,
  planAttach,
  planSend,
  planStop,
  readTurn,
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
