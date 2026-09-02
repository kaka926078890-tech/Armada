import { describe, expect, test } from "bun:test";
import {
  createCdpSubmitter,
  createImagePaster,
  COMPOSER_FOCUS_JS,
  COMPOSER_FOCUS_IMAGE_JS,
  COMPOSER_CHIP_COUNT_JS,
  COMPOSER_VERIFY_JS,
  COMPOSER_ENTER_JS,
  type CdpSession,
} from "../src/cdpInject";

const PAGE = { type: "page", title: "hello.txt — armada-test-ws", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" };

type CallLog = { method: string; params?: Record<string, unknown> };

/** 用脚本化的 Runtime.evaluate 返回值构造 mock session;insertText/Enter 默认成功 */
function mockSession(evalResults: string[], log: CallLog[] = []): CdpSession {
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

function mockDoc(texts: string[], imgCounts: number[] = []) {
  const els = texts.map((innerText, i) => ({
    innerText,
    offsetWidth: 100,
    offsetHeight: 24,
    focused: false,
    imgCount: imgCounts[i] ?? 0,
    focus() { this.focused = true; },
    dispatchEvent() { return true; },
    querySelectorAll(sel: string) {
      if (sel === "img") return Array.from({ length: this.imgCount }, () => ({}));
      return [];
    },
  }));
  return {
    els,
    querySelectorAll() { return els; },
  };
}

function runJs(src: string, texts: string[], prompt: string, imgCounts?: number[]): { result: string; els: ReturnType<typeof mockDoc>["els"] } {
  const document = mockDoc(texts, imgCounts);
  const KeyboardEvent = class {
    constructor(public type: string, public init?: unknown) {}
  };
  const fn = new Function("document", "KeyboardEvent", `return (${src});`)(document, KeyboardEvent);
  return { result: String(fn(prompt)), els: document.els };
}

function runJs0(src: string, texts: string[], imgCounts?: number[]): { result: string; els: ReturnType<typeof mockDoc>["els"] } {
  const document = mockDoc(texts, imgCounts);
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

  test("VERIFY 在多框中找匹配 prompt 的那一个", () => {
    expect(runJs(COMPOSER_VERIFY_JS, ["当前长对话", "你好世界"], "你好世界").result).toBe("OK");
  });

  test("ENTER 打在匹配草稿的框而不是 els[0]", () => {
    const { result, els } = runJs(COMPOSER_ENTER_JS, ["当前长对话", "你好"], "你好");
    expect(result).toBe("OK");
    expect(els[1].focused).toBe(true);
  });

  test("只附图 ENTER 打在带 img 的框", () => {
    const { result, els } = runJs(COMPOSER_ENTER_JS, ["旧对话", "chip"], "", [0, 2]);
    expect(result).toBe("OK");
    expect(els[1].focused).toBe(true);
  });

  test("CHIP_COUNT 累加可见框内 img", () => {
    expect(runJs0(COMPOSER_CHIP_COUNT_JS, ["", ""], [1, 2]).result).toBe("3");
  });

  test("FOCUS_IMAGE 优先空且无芯片的框", () => {
    const { els } = runJs0(COMPOSER_FOCUS_IMAGE_JS, ["旧对话", ""], [0, 0]);
    expect(els[1].focused).toBe(true);
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
    const paste = createImagePaster(deps({ connect: async () => mockSession(["OK", "OK", "0"], log) }));
    const r = await paste("/Users/x/armada-test-ws", "hi", [{ bytes: Buffer.from("x"), mime: "image/png" }], () => {}, true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("CHIP_COUNT");
    expect(log.some((c) => c.method === "Input.insertText")).toBe(false);
  });

  test("chips then prompt then Enter; paste uses dispatchKeyEvent not insertText for the image", async () => {
    const log: CallLog[] = [];
    const paste = createImagePaster(deps({
      connect: async () => mockSession(["OK", "OK", "1", "OK"], log),
    }));
    const r = await paste("/Users/x/armada-test-ws", "看图", [{ bytes: Buffer.from("x"), mime: "image/png" }], () => {}, true);
    expect(r.ok).toBe(true);
    expect(log.some((c) => c.method === "Input.dispatchKeyEvent")).toBe(true);
    const insert = log.find((c) => c.method === "Input.insertText");
    expect(insert?.params?.text).toBe("看图");
  });
});
