import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parsePlanInspect, planInspectToAsk } from "../src/askDetect";
import {
  createCdpSubmitter,
  createImagePaster,
  createFileMentionPaster,
  createAskQuestionDriver,
  probeCdpReady,
  COMPOSER_FOCUS_JS,
  COMPOSER_FOCUS_IMAGE_JS,
  COMPOSER_CHIP_COUNT_JS,
  COMPOSER_VERIFY_JS,
  COMPOSER_ENTER_JS,
  ASK_INSPECT_JS,
  ASK_CLICK_LETTER_JS,
  PLAN_INSPECT_JS,
  PLAN_CLICK_BUILD_JS,
  type CdpSession,
} from "../src/cdpInject";

const PAGE = { type: "page", title: "hello.txt — armada-test-ws", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" };

type CallLog = { method: string; params?: Record<string, unknown> };

/** 用脚本化的 Runtime.evaluate 返回值构造 mock session;insertText/Enter 默认成功 */
function mockSession(evalResults: unknown[], log: CallLog[] = []): CdpSession {
  let i = 0;
  return {
    async call(method, params) {
      log.push({ method, params });
      if (method === "Runtime.evaluate") {
        const v = evalResults[Math.min(i++, evalResults.length - 1)];
        return { result: { value: v } };
      }
      return {};
    },
    close() {},
  };
}

function deps(over: Partial<Parameters<typeof createCdpSubmitter>[0]> = {}) {
  return {
    port: 9222,
    fetchJson: async () => [PAGE],
    connect: async () => mockSession(["OK", "OK", "OK"]),
    sleep: async () => {},
    ...over,
  };
}

/** P1 真机：芯片在 .ai-input-full-input-box 内、输入框 8 层祖先之外；composer-bar 上另有 transcript 药丸不得计入。 */
function mockDoc(texts: string[], pillCounts: number[] = [], shareBox = false) {
  const strayTranscriptPills = [{}, {}, {}];
  const makeBox = (pills: object[]) => ({
    className: "ai-input-full-input-box full-input-box ",
    offsetHeight: 113,
    parentElement: {
      className: "composer-bar editor",
      offsetHeight: 800,
      querySelectorAll(sel: string) {
        if (sel === ".context-pill-image") return strayTranscriptPills;
        return [];
      },
    },
    querySelectorAll(sel: string) {
      if (sel === ".context-pill-image") return pills;
      return [];
    },
  });
  const sharedPills = shareBox
    ? Array.from({ length: pillCounts[0] ?? 0 }, () => ({ className: "context-pill-image" }))
    : null;
  const sharedBox = shareBox ? makeBox(sharedPills!) : null;
  const els = texts.map((innerText, i) => {
    const el: {
      innerText: string;
      offsetWidth: number;
      offsetHeight: number;
      className: string;
      focused: boolean;
      parentElement: object | undefined;
      focus: () => void;
      dispatchEvent: () => boolean;
      querySelectorAll: (sel: string) => object[];
    } = {
      innerText,
      offsetWidth: 100,
      offsetHeight: 24,
      className: "aislash-editor-input",
      focused: false,
      parentElement: undefined,
      focus() { this.focused = true; },
      dispatchEvent() { return true; },
      querySelectorAll() { return []; },
    };
    let node: { parentElement?: object } = el;
    for (let w = 0; w < 8; w++) {
      const wrap = { className: "", offsetHeight: 22, parentElement: undefined as object | undefined, querySelectorAll() { return []; } };
      node.parentElement = wrap;
      node = wrap;
    }
    const pills = sharedPills ?? Array.from({ length: pillCounts[i] ?? 0 }, () => ({ className: "context-pill-image" }));
    node.parentElement = sharedBox ?? makeBox(pills);
    return el;
  });
  return {
    els,
    querySelectorAll() { return els; },
  };
}

function runJs(src: string, texts: string[], prompt: string, imgCounts?: number[], reclaim?: string[]): { result: string; els: ReturnType<typeof mockDoc>["els"] } {
  const document = mockDoc(texts, imgCounts);
  const KeyboardEvent = class {
    constructor(public type: string, public init?: unknown) {}
  };
  const fn = new Function("document", "KeyboardEvent", `return (${src});`)(document, KeyboardEvent);
  return { result: String(fn(prompt, reclaim)), els: document.els };
}

function runJs0(src: string, texts: string[], pillCounts?: number[], shareBox = false): { result: string; els: ReturnType<typeof mockDoc>["els"] } {
  const document = mockDoc(texts, pillCounts, shareBox);
  const KeyboardEvent = class {
    constructor(public type: string, public init?: unknown) {}
  };
  const fn = new Function("document", "KeyboardEvent", `return (${src});`)(document, KeyboardEvent);
  return { result: String(fn()), els: document.els };
}

describe("composer picker JS", () => {
  test("同窗已有非空对话时优先空框", () => {
    const { result, els } = runJs(COMPOSER_FOCUS_JS, ["当前长对话内容", ""], "你好");
    expect(result).toBe("OK");
    expect(els[0].focused).toBe(false);
    expect(els[1].focused).toBe(true);
  });

  test("无空框但草稿前缀匹配 → DRAFT", () => {
    const { result, els } = runJs(COMPOSER_FOCUS_JS, ["别的对话", "你好"], "你好");
    expect(result).toBe("DRAFT");
    expect(els[1].focused).toBe(true);
  });

  test("只有无关非空框 → NON_EMPTY", () => {
    expect(runJs(COMPOSER_FOCUS_JS, ["当前长对话内容"], "你好").result).toBe("NON_EMPTY:当前长对话内容");
  });

  // 2026-09-03 10:49 真机：续聊 prompt 对不上框里已有的半截字，剪贴板追加后仍按「必须开头匹配」拒回车。
  const leftover = "帮我重新启动并";
  const followup = "为什么ACP不吃这份改动，是原先限定了这部分内容对么？";
  const pasted = leftover + followup;

  test("10:49 残留半截字且不含 prompt → 仍 NON_EMPTY（不误打进旧草稿）", () => {
    expect(runJs(COMPOSER_FOCUS_JS, [leftover], followup).result).toBe(`NON_EMPTY:${leftover}`);
  });

  test("10:49 剪贴板追加后 prompt 在框中部 → DRAFT（应回车）", () => {
    const { result, els } = runJs(COMPOSER_FOCUS_JS, [pasted], followup);
    expect(result).toBe("DRAFT");
    expect(els[0].focused).toBe(true);
  });

  test("他框中部含 16 字片段不得 DRAFT；完整 prompt 在末尾的框才命中", () => {
    const fragment = followup.slice(0, 16);
    const other = `请看这段：${fragment}，不是本轮。`;
    const { result, els } = runJs(COMPOSER_FOCUS_JS, [other, pasted], followup);
    expect(result).toBe("DRAFT");
    expect(els[0].focused).toBe(false);
    expect(els[1].focused).toBe(true);
  });

  test("短句「继续」不把仅中部提及的旧框当草稿", () => {
    expect(runJs(COMPOSER_FOCUS_JS, ["请继续之前的方案讨论"], "继续").result)
      .toBe("NON_EMPTY:请继续之前的方案讨论");
    const { result, els } = runJs(COMPOSER_FOCUS_JS, ["请继续之前的方案讨论", "残留继续"], "继续");
    expect(result).toBe("DRAFT");
    expect(els[1].focused).toBe(true);
  });

  // 2026-09-18 14:33 真机：cancel 后原文回灌，followup 被 NON_EMPTY_INPUT 拒掉。
  const cancelled = "findesk feat/in-app-browser-skill 45079948d feat(browser)";
  const nextFollowup = "帮我进行一下codereview";

  test("取消回灌原文且 reclaim 命中 → OWNED", () => {
    const { result, els } = runJs(COMPOSER_FOCUS_JS, [cancelled], nextFollowup, undefined, [cancelled]);
    expect(result).toBe("OWNED");
    expect(els[0].focused).toBe(true);
  });

  test("空框优先于 reclaim 残留，不误打进旧对话", () => {
    const { result, els } = runJs(COMPOSER_FOCUS_JS, [cancelled, ""], nextFollowup, undefined, [cancelled]);
    expect(result).toBe("OK");
    expect(els[0].focused).toBe(false);
    expect(els[1].focused).toBe(true);
  });

  test("外人草稿不因无关 reclaim 变成 OWNED", () => {
    expect(runJs(COMPOSER_FOCUS_JS, ["用户自己打的半截"], nextFollowup, undefined, [cancelled]).result)
      .toBe("NON_EMPTY:用户自己打的半截");
  });

  test("reclaim 空白折叠：innerText 制表符对得上空格原文", () => {
    const tabbed = cancelled.replace(" ", "\t");
    expect(runJs(COMPOSER_FOCUS_JS, [tabbed], nextFollowup, undefined, [cancelled]).result).toBe("OWNED");
  });

  test("本枪 prompt 相等仍 DRAFT，优先于 OWNED", () => {
    const { result, els } = runJs(COMPOSER_FOCUS_JS, [nextFollowup], nextFollowup, undefined, [cancelled]);
    expect(result).toBe("DRAFT");
    expect(els[0].focused).toBe(true);
  });

  test("10:49 追加后 ENTER 打在含 prompt 的框，即使不是以 prompt 开头", () => {
    const { result, els } = runJs(COMPOSER_ENTER_JS, ["旧对话", pasted], followup);
    expect(result).toBe("OK");
    expect(els[0].focused).toBe(false);
    expect(els[1].focused).toBe(true);
  });

  test("VERIFY 在多框中找匹配 prompt 的那一个", () => {
    expect(runJs(COMPOSER_VERIFY_JS, ["当前长对话", "你好世界"], "你好世界").result).toBe("OK");
  });

  test("ENTER 打在匹配草稿的框而不是 els[0]", () => {
    const { result, els } = runJs(COMPOSER_ENTER_JS, ["当前长对话", "你好"], "你好");
    expect(result).toBe("OK");
    expect(els[1].focused).toBe(true);
  });

  test("只附图 ENTER 打在带芯片的框", () => {
    const { result, els } = runJs(COMPOSER_ENTER_JS, ["旧对话", "chip"], "", [0, 2]);
    expect(result).toBe("OK");
    expect(els[1].focused).toBe(true);
  });

  test("CHIP_COUNT 只计 FOCUS_IMAGE 会选的目标框，邻框有图不算", () => {
    expect(runJs0(COMPOSER_CHIP_COUNT_JS, ["旧对话带图", ""], [2, 0]).result).toBe("0");
  });

  test("CHIP_COUNT 无空框时计带芯片的目标框", () => {
    expect(runJs0(COMPOSER_CHIP_COUNT_JS, ["chip"], [2]).result).toBe("2");
  });

  test("CHIP_COUNT 不把 8 层内的空祖先当根，且不计 composer-bar 上的 transcript 药丸", () => {
    expect(runJs0(COMPOSER_CHIP_COUNT_JS, [""], [1]).result).toBe("1");
  });

  test("CHIP_COUNT 同输入框两个 editor 不重复计药丸", () => {
    expect(runJs0(COMPOSER_CHIP_COUNT_JS, ["", ""], [1], true).result).toBe("1");
  });

  test("FOCUS_IMAGE 优先空且无芯片的框", () => {
    const { els } = runJs0(COMPOSER_FOCUS_IMAGE_JS, ["旧对话", ""], [0, 0]);
    expect(els[1].focused).toBe(true);
  });
});

describe("probeCdpReady", () => {
  test("2xx array is ready; throw or non-array is not", async () => {
    expect(await probeCdpReady({ port: 9222, fetchJson: async () => [{ type: "page" }] })).toBe(true);
    expect(await probeCdpReady({ port: 9222, fetchJson: async () => { throw new Error("ECONNREFUSED"); } })).toBe(false);
    expect(await probeCdpReady({ port: 9222, fetchJson: async () => ({ error: "not array" }) as never })).toBe(false);
  });
});

describe("createCdpSubmitter", () => {
  test("CDP 不可达 → CDP_UNREACHABLE", async () => {
    const submit = createCdpSubmitter(deps({ fetchJson: async () => { throw new Error("ECONNREFUSED"); } }));
    expect(await submit("/Users/x/armada-test-ws", "hi")).toEqual({ ok: false, reason: "CDP_UNREACHABLE" });
  });

  test("无匹配窗口标题 → WINDOW_TARGET_NOT_FOUND", async () => {
    const submit = createCdpSubmitter(deps({ fetchJson: async () => [{ ...PAGE, title: "other-ws" }] }));
    const r = await submit("/Users/x/armada-test-ws", "hi");
    expect(r.reason).toBe("WINDOW_TARGET_NOT_FOUND");
  });

  test("sibling folder title does not steal inject via includes()", async () => {
    let used = "";
    const submit = createCdpSubmitter(deps({
      fetchJson: async () => [
        { type: "page", title: "b.ts — armada-test-ws", webSocketDebuggerUrl: "ws://wrong" },
        { type: "page", title: "a.ts — armada", webSocketDebuggerUrl: "ws://right" },
      ],
      connect: async (wsUrl) => {
        used = wsUrl;
        return mockSession(["OK", "OK", "OK"]);
      },
    }));
    expect((await submit("/Users/x/armada", "hi")).ok).toBe(true);
    expect(used).toBe("ws://right");
  });

  test("two windows of the same folder → WINDOW_TARGET_AMBIGUOUS", async () => {
    let connected = 0;
    const submit = createCdpSubmitter(deps({
      fetchJson: async () => [
        { type: "page", title: "a.ts — armada", webSocketDebuggerUrl: "ws://one" },
        { type: "page", title: "b.ts — armada", webSocketDebuggerUrl: "ws://two" },
      ],
      connect: async () => {
        connected += 1;
        return mockSession(["OK", "OK", "OK"]);
      },
    }));
    expect(await submit("/Users/x/armada", "hi")).toEqual({ ok: false, reason: "WINDOW_TARGET_AMBIGUOUS" });
    expect(connected).toBe(0);
  });

  test("happy path:focus → Input.insertText → 读回校验 → Enter", async () => {
    const log: CallLog[] = [];
    const submit = createCdpSubmitter(deps({ connect: async () => mockSession(["OK", "OK", "OK"], log) }));
    const r = await submit("/Users/x/armada-test-ws", "你好");
    expect(r.ok).toBe(true);
    const insert = log.find((c) => c.method === "Input.insertText");
    expect(insert?.params?.text).toBe("你好");
    expect(log.map((c) => c.method)).toEqual(["Runtime.evaluate", "Input.insertText", "Runtime.evaluate", "Runtime.evaluate"]);
  });

  test("NO_INPUT 重试后成功", async () => {
    const submit = createCdpSubmitter(deps({ connect: async () => mockSession(["NO_INPUT", "NO_INPUT", "OK", "OK", "OK"]) }));
    expect((await submit("/Users/x/armada-test-ws", "hi")).ok).toBe(true);
  });

  test("NO_INPUT 重试耗尽 → NO_INPUT_AFTER_RETRY", async () => {
    const submit = createCdpSubmitter(deps({ connect: async () => mockSession(["NO_INPUT"]) }));
    expect(await submit("/Users/x/armada-test-ws", "hi")).toEqual({ ok: false, reason: "NO_INPUT_AFTER_RETRY" });
  });

  test("NON_EMPTY 重试后仍非空 → NON_EMPTY_INPUT(不注入)", async () => {
    const log: CallLog[] = [];
    const submit = createCdpSubmitter(deps({ connect: async () => mockSession(["NON_EMPTY:别的草稿"], log) }));
    const r = await submit("/Users/x/armada-test-ws", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("NON_EMPTY_INPUT");
    expect(log.some((c) => c.method === "Input.insertText")).toBe(false);
  });

  test("先 NON_EMPTY(旧对话)后出现空框 → 注入并提交", async () => {
    const log: CallLog[] = [];
    const submit = createCdpSubmitter(deps({
      connect: async () => mockSession(["NON_EMPTY:当前长对话", "OK", "OK", "OK"], log),
    }));
    expect((await submit("/Users/x/armada-test-ws", "hi")).ok).toBe(true);
    expect(log.some((c) => c.method === "Input.insertText")).toBe(true);
  });

  test("DRAFT 匹配 → 直接提交不注入", async () => {
    const log: CallLog[] = [];
    const submit = createCdpSubmitter(deps({ connect: async () => mockSession(["DRAFT", "OK"], log) }));
    const r = await submit("/Users/x/armada-test-ws", "hi");
    expect(r.ok).toBe(true);
    expect(log.some((c) => c.method === "Input.insertText")).toBe(false);
  });

  test("NON_EMPTY 但内容等于 prompt(重载恢复草稿)→ 直接提交不注入", async () => {
    const log: CallLog[] = [];
    const submit = createCdpSubmitter(deps({ connect: async () => mockSession(["NON_EMPTY:hi", "OK"], log) }));
    const r = await submit("/Users/x/armada-test-ws", "hi");
    expect(r.ok).toBe(true);
    expect(log.some((c) => c.method === "Input.insertText")).toBe(false);
  });

  test("读回校验失败 → VERIFY_FAIL", async () => {
    const submit = createCdpSubmitter(deps({ connect: async () => mockSession(["OK", "MISMATCH:garbage"]) }));
    const r = await submit("/Users/x/armada-test-ws", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("VERIFY_FAIL");
  });

  test("OWNED 残留 → Cmd/Ctrl+A 再 insertText 新 prompt，不 reject", async () => {
    const log: CallLog[] = [];
    const submit = createCdpSubmitter(deps({ connect: async () => mockSession(["OWNED", "OK", "OK"], log) }));
    const r = await submit("/Users/x/armada-test-ws", "续发", { reclaim: ["首轮原文"] });
    expect(r.ok).toBe(true);
    const keys = log.filter((c) => c.method === "Input.dispatchKeyEvent");
    expect(keys).toHaveLength(2);
    expect(keys[0]?.params?.code).toBe("KeyA");
    expect(keys[0]?.params?.modifiers).toBe(process.platform === "win32" ? 2 : 4);
    expect(log.find((c) => c.method === "Input.insertText")?.params?.text).toBe("续发");
  });

  test("NON_EMPTY 且 reclaim 命中（空白折叠）→ 全选替换", async () => {
    const log: CallLog[] = [];
    const leftover = "findesk\tfeat/in-app-browser-skill";
    const submit = createCdpSubmitter(deps({
      connect: async () => mockSession([`NON_EMPTY:${leftover}`, "OK", "OK"], log),
    }));
    const r = await submit("/Users/x/armada-test-ws", "续发", {
      reclaim: ["findesk feat/in-app-browser-skill"],
    });
    expect(r.ok).toBe(true);
    expect(log.some((c) => c.method === "Input.insertText")).toBe(true);
    expect(log.filter((c) => c.method === "Input.dispatchKeyEvent")).toHaveLength(2);
  });

  test("WS 连接失败 → CDP_CONNECT_FAIL", async () => {
    const submit = createCdpSubmitter(deps({ connect: async () => { throw new Error("boom"); } }));
    const r = await submit("/Users/x/armada-test-ws", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("CDP_CONNECT_FAIL");
  });
});

describe("createImagePaster", () => {
  test("chip count never reaches N → CHIP_COUNT and no Enter", async () => {
    const log: CallLog[] = [];
    const paste = createImagePaster(deps({ connect: async () => mockSession(["OK", "0"], log) }));
    const r = await paste("/Users/x/armada-test-ws", "hi", [{ bytes: Buffer.from("x"), mime: "image/png" }], () => {}, true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("CHIP_COUNT");
    expect(log.some((c) => c.method === "Input.insertText")).toBe(false);
  });

  test("already counted chips skip extra Cmd+V", async () => {
    const log: CallLog[] = [];
    const paste = createImagePaster(deps({
      connect: async () => mockSession(["OK", "1", "OK", "OK"], log),
    }));
    const r = await paste("/Users/x/armada-test-ws", "看图", [{ bytes: Buffer.from("x"), mime: "image/png" }], () => {}, true);
    expect(r.ok).toBe(true);
    expect(log.filter((c) => c.method === "Input.dispatchKeyEvent")).toHaveLength(0);
    expect(log.find((c) => c.method === "Input.insertText")?.params?.text).toBe("看图");
  });

  test("chips then prompt then Enter; paste uses dispatchKeyEvent not insertText for the image", async () => {
    const log: CallLog[] = [];
    const paste = createImagePaster(deps({
      connect: async () => mockSession(["OK", "0", "OK", "1", "OK", "OK"], log),
    }));
    const r = await paste("/Users/x/armada-test-ws", "看图", [{ bytes: Buffer.from("x"), mime: "image/png" }], () => {}, true);
    expect(r.ok).toBe(true);
    expect(log.filter((c) => c.method === "Input.dispatchKeyEvent")).toHaveLength(2);
    const insert = log.find((c) => c.method === "Input.insertText");
    expect(insert?.params?.text).toBe("看图");
  });
});

describe("createFileMentionPaster", () => {
  test("NO_MENU then OK still mentions (Windows typeahead is slow)", async () => {
    const paste = createFileMentionPaster(deps({
      connect: async () => mockSession(["OK", "NO_MENU", "NO_MENU", "OK", 1]),
    }));
    const r = await paste("/Users/x/armada-test-ws", ["eb022972-2026-09-17.aioncore.log"]);
    expect(r).toEqual({ ok: true });
  });

  test("menu never appears → MENTION_CLICK:NO_MENU", async () => {
    const paste = createFileMentionPaster(deps({
      connect: async () => mockSession(["OK", "NO_MENU"]),
    }));
    const r = await paste("/Users/x/armada-test-ws", ["notes.txt"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("MENTION_CLICK:NO_MENU");
  });
});

const FIXTURE_TEXT = "Questions 1 of 1 1. 这是本机验证用的 Questions 框。请任选一项并点 Continue；后台正在用 CDP 抓 DOM。 A 选项 A（验证单选） B 选项 B C Skip 也行，只要框出现过 D Skip Esc Continue ⏎";

function mockAskDoc(letters: string[], selected?: string, innerText = FIXTURE_TEXT, composerId?: string, ariaByLetter: Record<string, string> = {}) {
  const btns = letters.map((L) => ({
    innerText: L,
    className: L === selected
      ? "composer-questionnaire-toolbar-option-letter composer-questionnaire-toolbar-option-letter-selected"
      : "composer-questionnaire-toolbar-option-letter",
    focused: false,
    clicked: false,
    focus() { this.focused = true; },
    click() { this.clicked = true; },
    getAttribute(name: string) {
      if (name === "aria-label") return ariaByLetter[L] ?? null;
      return null;
    },
  }));
  const bar: {
    className: string;
    innerText: string;
    parentElement: { getAttribute: (name: string) => string | null; parentElement: null } | null;
    querySelectorAll: (sel: string) => typeof btns | [];
    scrollIntoView: () => void;
  } = {
    className: "composer-questionnaire-toolbar",
    innerText,
    parentElement: composerId
      ? {
        getAttribute(name: string) { return name === "data-composer-id" ? composerId : null; },
        parentElement: null,
      }
      : null,
    querySelectorAll(sel: string) {
      if (sel === "button.composer-questionnaire-toolbar-option-letter") return btns;
      return [];
    },
    scrollIntoView() {},
  };
  return {
    btns,
    querySelector(sel: string) {
      if (sel === ".composer-questionnaire-toolbar") return bar;
      return null;
    },
    querySelectorAll() { return []; },
  };
}

function runAskInspect(letters: string[], composerId?: string, ariaByLetter?: Record<string, string>) {
  const document = mockAskDoc(letters, "A", FIXTURE_TEXT, composerId, ariaByLetter);
  const fn = new Function("document", `return (${ASK_INSPECT_JS});`)(document);
  return { result: fn() as { present: boolean; prompt: string; conversation_id?: string; options: { id: string; label: string; text: string }[]; skip_unidentified?: boolean }, btns: document.btns };
}

function runAskClick(letters: string[], letter: string) {
  const document = mockAskDoc(letters);
  const fn = new Function("document", `return (${ASK_CLICK_LETTER_JS});`)(document);
  return { result: String(fn(letter)), btns: document.btns };
}

describe("AskQuestion toolbar JS", () => {
  test("inspect drops the Skip letter and keeps A/B/C from the CDP fixture", () => {
    const { result } = runAskInspect(["A", "B", "C", "Skip"]);
    expect(result.present).toBe(true);
    expect(result.options.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(result.skip_unidentified).toBeFalsy();
    expect(result.prompt).toContain("这是本机验证用的 Questions 框");
    expect(result.options[0]?.text).toContain("选项 A");
  });

  test("inspect with one letter button keeps that option", () => {
    const { result } = runAskInspect(["A"]);
    expect(result.present).toBe(true);
    expect(result.options.map((o) => o.id)).toEqual(["a"]);
    expect(result.skip_unidentified).toBeFalsy();
  });

  test("inspect identifies Skip by aria-label when innerText is not Skip", () => {
    const { result } = runAskInspect(["A", "B", "C"], undefined, { B: "Skip this question" });
    expect(result.options.map((o) => o.id)).toEqual(["a", "c"]);
    expect(result.skip_unidentified).toBeFalsy();
  });

  test("inspect keeps every letter and sets skip_unidentified when Skip cannot be identified", () => {
    const { result } = runAskInspect(["A", "B"]);
    expect(result.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(result.skip_unidentified).toBe(true);
  });

  test("inspect returns data-composer-id from the owning composer-bar", () => {
    const { result } = runAskInspect(["A", "B", "C", "D"], "15eba46c-1011-44b3-9535-f00596728279");
    expect(result.present).toBe(true);
    expect(result.conversation_id).toBe("15eba46c-1011-44b3-9535-f00596728279");
  });

  test("Windows portal toolbar: cid comes from the unique visible composer input", () => {
    const cid = "ca3d4388-990d-44cc-bb43-b472bee8812c";
    const bar = {
      className: "composer-questionnaire-toolbar",
      innerText: "Questions 1 of 1 1. 这批修复你更想先落地哪一层？ A x B y C z D w Skip Esc Continue",
      parentElement: { getAttribute: () => null, parentElement: null },
      querySelectorAll(sel: string) {
        if (sel === "button.composer-questionnaire-toolbar-option-letter") {
          return ["A", "B", "C", "D", "Skip"].map((L) => ({ innerText: L }));
        }
        return [];
      },
    };
    const input = {
      innerText: "",
      offsetWidth: 120,
      offsetHeight: 40,
      parentElement: {
        getAttribute(name: string) { return name === "data-composer-id" ? cid : null; },
        parentElement: null,
      },
    };
    const document = {
      querySelector(sel: string) {
        if (sel === ".composer-questionnaire-toolbar") return bar;
        return null;
      },
      querySelectorAll(sel: string) {
        if (sel === "[data-composer-id]") return [input.parentElement];
        if (sel.includes("tiptap") || sel.includes("aislash-editor-input")) return [input];
        return [];
      },
    };
    (input.parentElement as { contains?: (n: unknown) => boolean }).contains = () => false;
    const fn = new Function("document", `return (${ASK_INSPECT_JS});`)(document);
    const result = fn() as { present: boolean; conversation_id: string; options: { id: string }[] };
    expect(result.present).toBe(true);
    expect(result.conversation_id).toBe(cid);
  });

  test("two visible composer cids with a portaled toolbar stay empty (no last-key)", () => {
    const mkInput = (cid: string) => {
      const parent = {
        getAttribute(name: string) { return name === "data-composer-id" ? cid : null; },
        parentElement: null,
        contains: () => false,
      };
      return {
        innerText: "hi",
        offsetWidth: 100,
        offsetHeight: 20,
        parentElement: parent,
      };
    };
    const a = mkInput("cid-a");
    const b = mkInput("cid-b");
    const bar = {
      innerText: "Questions 1 of 1 1. q A x B y Skip Esc Continue",
      parentElement: null,
      querySelectorAll(sel: string) {
        if (sel === "button.composer-questionnaire-toolbar-option-letter") return [{ innerText: "A" }, { innerText: "B" }, { innerText: "Skip" }];
        return [];
      },
    };
    const document = {
      querySelector(sel: string) {
        if (sel === ".composer-questionnaire-toolbar") return bar;
        return null;
      },
      querySelectorAll(sel: string) {
        if (sel === "[data-composer-id]") return [a.parentElement, b.parentElement];
        if (sel.includes("tiptap") || sel.includes("aislash-editor-input")) return [a, b];
        return [];
      },
    };
    const fn = new Function("document", `return (${ASK_INSPECT_JS});`)(document);
    const result = fn() as { conversation_id: string };
    expect(result.conversation_id).toBe("");
  });

  test("click B hits B; D is Skip and must not be clicked", () => {
    const b = runAskClick(["A", "B", "C", "D"], "B");
    expect(b.result).toBe("OK");
    expect(b.btns[1]?.clicked).toBe(true);
    const d = runAskClick(["A", "B", "C", "D"], "D");
    expect(d.result).toBe("NO_LETTER");
    expect(d.btns[3]?.clicked).toBe(false);
  });
});

describe("AskQuestion CDP driver", () => {
  test("inspect: fetchJson throw is unknown not absent", async () => {
    const driver = createAskQuestionDriver(deps({
      fetchJson: async () => { throw new Error("ECONNREFUSED"); },
    }));
    expect(await driver.inspect("/Users/x/armada-test-ws")).toEqual({
      unknown: true, reason: "CDP_UNREACHABLE",
    });
  });

  test("inspect: connect throw is unknown not absent", async () => {
    const driver = createAskQuestionDriver(deps({
      connect: async () => { throw new Error("boom"); },
    }));
    const hit = await driver.inspect("/Users/x/armada-test-ws");
    expect(hit).toMatchObject({ unknown: true });
    expect(hit).not.toEqual({ present: false });
  });

  test("inspect: eval throw is unknown not absent", async () => {
    const driver = createAskQuestionDriver(deps({
      connect: async () => ({
        async call() { throw new Error("eval fail"); },
        close() {},
      }),
    }));
    const hit = await driver.inspect("/Users/x/armada-test-ws");
    expect(hit).toMatchObject({ unknown: true });
    expect(hit).not.toEqual({ present: false });
  });

  test("plan inspect maps CDP value through planInspectToAsk(parsePlanInspect)", async () => {
    const raw = {
      present: true,
      filename: "Markdown date line",
      overview: "在任意一份现有 markdown 文件末尾追加一行日期",
      conversation_id: "17ce6eee-b18a-4550-9548-b1b50040ca27",
    };
    const driver = createAskQuestionDriver(deps({
      connect: async () => mockSession([{ present: false }, raw]),
    }));
    expect(await driver.inspect("/Users/x/armada-test-ws")).toEqual(planInspectToAsk(parsePlanInspect(raw)));
    const src = readFileSync(join(import.meta.dir, "../src/cdpInject.ts"), "utf8");
    expect(src).toMatch(/planInspectToAsk\s*\(\s*parsePlanInspect\s*\(/);
    expect(src).not.toMatch(/prompt:\s*`Created Plan: \$\{filename\}`/);
  });

  test("inspect connect throw plus pending does not resolve via askPollActions", async () => {
    const { askPollActions } = await import("../src/askDetect");
    const driver = createAskQuestionDriver(deps({
      connect: async () => { throw new Error("boom"); },
    }));
    const inspect = await driver.inspect("/Users/x/armada-test-ws");
    const acts = askPollActions(
      new Map([["r-1", { conversationId: "cid-1" }]]),
      new Map([["r-1", "ask-1"]]),
      inspect,
      () => "x",
    );
    expect(acts).toEqual([]);
  });

  test("continue clicks letter then CDP Enter, never composer insertText/ENTER JS", async () => {
    const log: CallLog[] = [];
    const driver = createAskQuestionDriver(deps({
      connect: async () => mockSession(["OK", { present: false }], log),
    }));
    const r = await driver.submit("/Users/x/armada-test-ws", "continue", "b");
    expect(r.ok).toBe(true);
    expect(log.some((c) => c.method === "Input.insertText")).toBe(false);
    expect(log.some((c) => c.method === "Input.dispatchKeyEvent" && c.params?.key === "Enter")).toBe(true);
    const evals = log.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params?.expression ?? ""));
    expect(evals.some((e) => e.includes("composer-questionnaire-toolbar-option-letter"))).toBe(true);
    expect(evals.some((e) => e.includes("armadaDraftHit"))).toBe(false);
  });

  test("skip sends Escape not Enter", async () => {
    const log: CallLog[] = [];
    const driver = createAskQuestionDriver(deps({
      connect: async () => mockSession([{ present: false }], log),
    }));
    const r = await driver.submit("/Users/x/armada-test-ws", "skip");
    expect(r.ok).toBe(true);
    expect(log.some((c) => c.method === "Input.dispatchKeyEvent" && c.params?.key === "Escape")).toBe(true);
    expect(log.some((c) => c.method === "Input.dispatchKeyEvent" && c.params?.key === "Enter")).toBe(false);
  });

  test("Build clicks plan split-button and does not dispatch Enter", async () => {
    const log: CallLog[] = [];
    const driver = createAskQuestionDriver(deps({
      connect: async () => mockSession(["OK", { present: false }], log),
    }));
    const r = await driver.submit("/Users/x/armada-test-ws", "continue", "build", "plan");
    expect(r.ok).toBe(true);
    const evals = log.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params?.expression ?? ""));
    expect(evals.some((e) => e.includes("split-button") && e.includes("Build"))).toBe(true);
    expect(evals.some((e) => e.includes("composer-questionnaire-toolbar-option-letter"))).toBe(false);
    expect(log.some((c) => c.method === "Input.dispatchKeyEvent")).toBe(false);
  });

  test("kind=plan clicks plan split-button even when letter is not build", async () => {
    const log: CallLog[] = [];
    const driver = createAskQuestionDriver(deps({
      connect: async () => mockSession(["OK", { present: false }], log),
    }));
    const r = await driver.submit("/Users/x/armada-test-ws", "continue", "x", "plan");
    expect(r.ok).toBe(true);
    const evals = log.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params?.expression ?? ""));
    expect(evals.some((e) => e.includes("split-button") && e.includes("Build"))).toBe(true);
    expect(evals.some((e) => e.includes("composer-questionnaire-toolbar-option-letter"))).toBe(false);
    expect(log.some((c) => c.method === "Input.dispatchKeyEvent")).toBe(false);
  });

  test("letter=build without kind clicks Ask letter, not plan split-button", async () => {
    const log: CallLog[] = [];
    const driver = createAskQuestionDriver(deps({
      connect: async () => mockSession(["OK", { present: false }], log),
    }));
    const r = await driver.submit("/Users/x/armada-test-ws", "continue", "build");
    expect(r.ok).toBe(true);
    const evals = log.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params?.expression ?? ""));
    expect(evals.some((e) => e.includes("composer-questionnaire-toolbar-option-letter"))).toBe(true);
    expect(evals.some((e) => e.includes("split-button") && e.includes("Build"))).toBe(false);
    expect(log.some((c) => c.method === "Input.dispatchKeyEvent" && c.params?.key === "Enter")).toBe(true);
  });

  test("submit branches on kind===plan, not letter===build", () => {
    const src = readFileSync(join(import.meta.dir, "../src/cdpInject.ts"), "utf8");
    const start = src.indexOf("export function createAskQuestionDriver");
    const driver = src.slice(start, src.indexOf("export type CdpSubmitOpts"));
    expect(driver).toMatch(/kind\s*===\s*["']plan["']/);
    expect(driver).not.toMatch(/toLowerCase\(\)\s*===\s*["']build["']/);
  });

  test("extension forwards kind into askDriver.submit", () => {
    const src = readFileSync(join(import.meta.dir, "../src/extension.ts"), "utf8");
    expect(src).toMatch(/askDriver\.submit\(\s*workspaceRoot,\s*action,\s*letter,\s*kind\s*\)/);
  });
});

function mockPlanDoc(opts: { filename: string; build: boolean; composerId?: string; overview?: string }) {
  const buildBtn = {
    innerText: "Build\n⌘⏎",
    clicked: false,
    focused: false,
    focus() { this.focused = true; },
    click() { this.clicked = true; },
  };
  const split = opts.build
    ? {
      getAttribute(name: string) {
        if (name === "data-component") return "split-button";
        if (name === "data-tone") return "plan";
        return null;
      },
      querySelectorAll(sel: string) {
        if (sel === "button") return [buildBtn];
        return [];
      },
      scrollIntoView() {},
    }
    : null;
  const bar = {
    className: "composer-bar editor",
    getAttribute(name: string) {
      return name === "data-composer-id" ? (opts.composerId ?? null) : null;
    },
    parentElement: null as null,
  };
  const card = {
    getAttribute(name: string) {
      return name === "data-component" ? "transcript-card-root" : null;
    },
    innerText: `Created Plan\n${opts.filename}\n\n${opts.overview ?? "overview"}\n\nView Plan\nBuild\n⌘⏎`,
    parentElement: bar,
  };
  const name = {
    innerText: opts.filename,
    getAttribute(name: string) {
      return name === "data-testid" ? "composer-plan-filename" : null;
    },
    parentElement: card,
  };
  return {
    buildBtn,
    querySelector(sel: string) {
      if (sel === "[data-testid=composer-plan-filename]") return name;
      if (sel === "[data-component=split-button][data-tone=plan]") return split;
      return null;
    },
  };
}

describe("Created Plan / Build JS", () => {
  test("inspect is present only while the Build split-button is on screen", () => {
    const live = mockPlanDoc({
      filename: "Markdown date line",
      build: true,
      composerId: "17ce6eee-b18a-4550-9548-b1b50040ca27",
      overview: "在任意一份现有 markdown 文件末尾追加一行日期",
    });
    const inspect = new Function("document", `return (${PLAN_INSPECT_JS});`)(live);
    expect(inspect()).toMatchObject({
      present: true,
      filename: "Markdown date line",
      conversation_id: "17ce6eee-b18a-4550-9548-b1b50040ca27",
      overview: "在任意一份现有 markdown 文件末尾追加一行日期",
    });
    const after = mockPlanDoc({ filename: "Markdown date line", build: false });
    const gone = new Function("document", `return (${PLAN_INSPECT_JS});`)(after);
    expect(gone()).toEqual({ present: false });
  });

  test("click Build hits the plan-tone primary button", () => {
    const live = mockPlanDoc({ filename: "Markdown date line", build: true });
    const click = new Function("document", `return (${PLAN_CLICK_BUILD_JS});`)(live);
    expect(click()).toBe("OK");
    expect(live.buildBtn.clicked).toBe(true);
  });

  test("Windows inspect is present on ui-split-button Build without data-tone=plan", () => {
    const live = mockWinPlanDoc({
      filename: "Empty Plan Card",
      buildText: "Build\nCtrl+⏎",
      composerId: "a1b3efe0-7e33-4d36-ab49-9f2040469a78",
    });
    const inspect = new Function("document", `return (${PLAN_INSPECT_JS});`)(live);
    expect(inspect()).toMatchObject({
      present: true,
      filename: "Empty Plan Card",
      conversation_id: "a1b3efe0-7e33-4d36-ab49-9f2040469a78",
    });
  });

  test("Windows inspect is absent while the split shows Building", () => {
    const live = mockWinPlanDoc({
      filename: "Empty Plan Card",
      buildText: "Building...\nCtrl+⏎",
    });
    const inspect = new Function("document", `return (${PLAN_INSPECT_JS});`)(live);
    expect(inspect()).toEqual({ present: false });
  });

  test("click Build hits the Windows ui-split-button", () => {
    const live = mockWinPlanDoc({ filename: "Empty Plan Card", buildText: "Build\nCtrl+⏎" });
    const click = new Function("document", `return (${PLAN_CLICK_BUILD_JS});`)(live);
    expect(click()).toBe("OK");
    expect(live.buildBtn.clicked).toBe(true);
  });
});

function mockWinPlanDoc(opts: { filename: string; buildText: string; composerId?: string }) {
  const buildBtn = {
    innerText: opts.buildText,
    clicked: false,
    focused: false,
    parentElement: null as { className: string; scrollIntoView?: () => void } | null,
    getAttribute(_name: string) { return null; },
    focus() { this.focused = true; },
    click() { this.clicked = true; },
    scrollIntoView() {},
  };
  const viewBtn = {
    innerText: "View Plan",
    parentElement: null as null,
    getAttribute(name: string) { return name === "data-variant" ? "text" : null; },
  };
  const menuBtn = {
    innerText: "",
    parentElement: null as { className: string } | null,
    getAttribute(name: string) { return name === "aria-label" ? "Open menu" : null; },
  };
  const splitDiv = {
    className: "ui-split-button ui-3nfvp2 ui-1qjc9v5",
    scrollIntoView() {},
  };
  buildBtn.parentElement = splitDiv;
  menuBtn.parentElement = splitDiv;
  const bar = {
    className: "composer-bar editor",
    getAttribute(name: string) {
      return name === "data-composer-id" ? (opts.composerId ?? null) : null;
    },
    parentElement: null as null,
  };
  const card = {
    getAttribute(name: string) {
      return name === "data-component" ? "transcript-card-root" : null;
    },
    innerText: `Created Plan\n${opts.filename}\n\nplaceholder\n\nView Plan\nBuild\nCtrl+⏎`,
    parentElement: bar,
    querySelectorAll(sel: string) {
      if (sel === "button") return [viewBtn, buildBtn, menuBtn];
      return [];
    },
  };
  const name = {
    innerText: opts.filename,
    getAttribute(name: string) {
      return name === "data-testid" ? "composer-plan-filename" : null;
    },
    parentElement: card,
  };
  return {
    buildBtn,
    querySelector(sel: string) {
      if (sel === "[data-testid=composer-plan-filename]") return name;
      if (sel === "[data-component=split-button][data-tone=plan]") return null;
      return null;
    },
  };
}
