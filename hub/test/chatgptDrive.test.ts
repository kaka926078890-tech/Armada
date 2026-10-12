import { describe, expect, test } from "bun:test";
import { prepareAndSend, prepareFollowup, type ChatgptPage } from "../src/chatgptDrive";
import type { ChatgptControl } from "../src/chatgptDesktop";

function pageOf(
  shots: ChatgptControl[][],
  textAfterSend = "",
  opts: { conversation?: string; sessionAfterClick?: string } = {},
): ChatgptPage & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  let conversation = opts.conversation ?? "";
  const sessionAfterClick = opts.sessionAfterClick ?? conversation;
  return {
    calls,
    async controls() {
      calls.push("controls");
      return shots[Math.min(n++, shots.length - 1)];
    },
    async pointer(x, y) { calls.push(`pointer:${x},${y}`); },
    async clickName(name) { calls.push(`click:${name}`); },
    async insertText(text) { calls.push(`text:${text}`); },
    async composerText() { return textAfterSend; },
    async visibleConversation() { return conversation; },
    async clickThread(id: string) { calls.push(`thread:${id}`); conversation = sessionAfterClick; },
    close() { calls.push("close"); },
  };
}

const codex: ChatgptControl[] = [
  { name: "在 desk 中开始新聊天", kind: "button", x: 329, y: 177, w: 20, h: 20 },
  { name: "随心输入", kind: "textbox", x: 568, y: 779, w: 712, h: 44 },
  { name: "发送", kind: "button", x: 1256, y: 827, w: 28, h: 28 },
];

describe("prepareAndSend", () => {
  test("a project dispatch clicks that project's new chat, then send", async () => {
    const page = pageOf([codex, codex, codex]);
    await prepareAndSend(page, "chatgpt:desk", "只回复 armada-hub-ok");
    expect(page.calls).toEqual([
      "controls",
      "click:在 desk 中开始新聊天",
      "controls",
      "pointer:598,795",
      "text:只回复 armada-hub-ok",
      "controls",
      "click:发送",
    ]);
  });

  test("普通区 clicks 不在项目中工作 when that button is on screen", async () => {
    const withLeave: ChatgptControl[] = [
      ...codex,
      { name: "不在项目中工作", kind: "button", x: 573, y: 732, w: 28, h: 28 },
    ];
    const normal: ChatgptControl[] = [
      { name: "选择项目", kind: "button", x: 573, y: 732, w: 92, h: 28 },
      { name: "随心输入", kind: "textbox", x: 568, y: 779, w: 712, h: 44 },
      { name: "发送", kind: "button", x: 1256, y: 827, w: 28, h: 28 },
    ];
    const page = pageOf([withLeave, normal, normal]);
    await prepareAndSend(page, "chatgpt:", "hi");
    expect(page.calls.filter((call) => call.startsWith("click:"))).toEqual([
      "click:不在项目中工作",
      "click:发送",
    ]);
  });

  test("text still in the composer does not fail the click", async () => {
    const page = pageOf([codex, codex, codex], "只回复 armada-hub-ok");
    await prepareAndSend(page, "chatgpt:desk", "只回复 armada-hub-ok");
    expect(page.calls).toContain("click:发送");
  });

  test("a collapsed project is expanded before the new chat click", async () => {
    const collapsed: ChatgptControl[] = [
      { name: "desk", kind: "button", x: 60, y: 172, w: 261, h: 28 },
      { name: "随心输入", kind: "textbox", x: 568, y: 779, w: 712, h: 44 },
    ];
    const page = pageOf([collapsed, codex, codex, codex]);
    await prepareAndSend(page, "chatgpt:desk", "hi");
    expect(page.calls.filter((call) => call.startsWith("click:"))).toEqual([
      "click:desk",
      "click:在 desk 中开始新聊天",
      "click:发送",
    ]);
  });

  test("follow-up clicks the bound sidebar thread, then send", async () => {
    const page = pageOf([codex, codex], "", {
      conversation: "other",
      sessionAfterClick: "session-1",
    });
    await prepareFollowup(page, "session-1", "local:client-new-thread:abc", "下一句");
    expect(page.calls).toContain("thread:local:client-new-thread:abc");
    expect(page.calls).toContain("click:发送");
  });

  test("follow-up already on that thread does not click the sidebar", async () => {
    const page = pageOf([codex, codex], "", { conversation: "session-1" });
    await prepareFollowup(page, "session-1", null, "下一句");
    expect(page.calls.some((call) => call.startsWith("thread:"))).toBe(false);
    expect(page.calls).toContain("click:发送");
  });
});
