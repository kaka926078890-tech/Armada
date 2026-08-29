/**
 * CDP 注入:通过 Chromium 远程调试端口操作 composer DOM,实现全自动提交。
 *
 * 前提:Cursor 以 --remote-debugging-port 启动(见 scripts/armada-cursor.sh)。
 * 端口只连 127.0.0.1;任何失败都返回 ok=false,由调用方降级到剪贴板+人工回车。
 *
 * 真机实证(Cursor 3.15.19 / Electron 40)结论:
 * - composer 输入框: div.aislash-editor-input[contenteditable="true"](Agents 视图为 div.tiptap)
 * - 写入必须用 Input.insertText(浏览器真实输入管线);
 *   execCommand('insertText') 在刚挂载的空 composer 上会被编辑器模型对账吞掉(实测 VERIFY_FAIL)。
 * - 不做"清空再写入":selectAllChildren+delete 会被编辑器错误合并(实测内容翻倍)。
 *   composer 非空时:内容等于待注入 prompt(重载恢复的草稿)则直接提交;否则交调用方降级。
 * - 提交: 派发 keydown/keyup Enter(bubbles+composed),实证可触发 beforeSubmitPrompt。
 * - 同窗多个 composer 时优先空框(当前对话非空时 els[0] 是旧框,会误跳过回车)。
 */

export interface CdpSubmitResult {
  ok: boolean;
  reason?: string;
}

export interface CdpSession {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}

export interface CdpSubmitterDeps {
  port: number;
  fetchJson?: (url: string, timeoutMs: number) => Promise<any[]>;
  connect?: (wsUrl: string, timeoutMs: number) => Promise<CdpSession>;
  sleep?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
}

const SEL = 'div.aislash-editor-input[contenteditable="true"], div.tiptap[contenteditable="true"]';

/**
 * 同窗常有多个可见 composer(当前对话 + newAgentChat 新开的空框)。
 * 取 els[0] 会命中旧对话 → 误报 NON_EMPTY、只粘贴不回车。
 * 优先空框;否则匹配 prompt 前缀的草稿框。
 */
const VISIBLE_ELS = `Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(SEL)})).filter(function (e) { return e.offsetWidth > 0 && e.offsetHeight > 0; })`;

/** 导出供单测直接 eval(注入 mock document) */
export const COMPOSER_FOCUS_JS = `function (prompt) {
  var els = ${VISIBLE_ELS};
  if (!els.length) return "NO_INPUT";
  var promptT = String(prompt || "").trim();
  var prefix = promptT.slice(0, 16);
  var empty = null, matched = null;
  for (var i = 0; i < els.length; i++) {
    var t = els[i].innerText.trim();
    if (!t) { if (!empty) empty = els[i]; }
    else if (prefix && t.indexOf(prefix) === 0) { if (!matched) matched = els[i]; }
  }
  if (empty) { empty.focus(); return "OK"; }
  if (matched) { matched.focus(); return "DRAFT"; }
  return "NON_EMPTY:" + els[0].innerText.trim();
}`;

export const COMPOSER_VERIFY_JS = `function (prompt) {
  var els = ${VISIBLE_ELS};
  var prefix = String(prompt || "").slice(0, 16);
  for (var i = 0; i < els.length; i++) {
    if (els[i].innerText.indexOf(prefix) !== -1) return "OK";
  }
  if (!els.length) return "NO_INPUT";
  return "MISMATCH:" + els[0].innerText.slice(0, 40);
}`;

export const COMPOSER_ENTER_JS = `function (prompt) {
  var els = ${VISIBLE_ELS};
  if (!els.length) return "NO_INPUT";
  var promptT = String(prompt || "").trim();
  var prefix = promptT.slice(0, 16);
  var el = null;
  for (var i = 0; i < els.length; i++) {
    var t = els[i].innerText.trim();
    if (prefix && t.indexOf(prefix) === 0) { el = els[i]; break; }
  }
  if (!el) {
    for (var j = 0; j < els.length; j++) {
      if (!els[j].innerText.trim()) { el = els[j]; break; }
    }
  }
  if (!el) return "NO_TARGET";
  el.focus();
  var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return "OK";
}`;

async function defaultFetchJson(url: string, timeoutMs: number): Promise<any[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return (await r.json()) as any[];
  } finally {
    clearTimeout(t);
  }
}

function defaultConnect(wsUrl: string, timeoutMs: number): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WebSocket = require("ws");
    const ws = new WebSocket(wsUrl);
    let mid = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("CDP_CONNECT_TIMEOUT")); }, timeoutMs);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({
        call(method, params = {}) {
          const id = ++mid;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { ws.close(); },
      });
    });
    ws.on("message", (data: unknown) => {
      const d = JSON.parse(String(data));
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error.message ?? "CDP_ERROR"));
      else p.resolve(d.result);
    });
    ws.on("error", (e: unknown) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

export function createCdpSubmitter(deps: CdpSubmitterDeps) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const connect = deps.connect ?? defaultConnect;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});

  return async function submit(workspaceRoot: string, prompt: string): Promise<CdpSubmitResult> {
    let targets: any[];
    try {
      targets = await fetchJson(`http://127.0.0.1:${deps.port}/json`, 1500);
    } catch {
      return { ok: false, reason: "CDP_UNREACHABLE" };
    }
    // 窗口标题含工作区文件夹名(VS Code 默认 window.title 格式),据此找到本窗口的 page target
    const base = workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot;
    const pages = targets.filter(
      (t) => t.type === "page" && typeof t.title === "string" && t.title.includes(base),
    );
    if (pages.length === 0) return { ok: false, reason: "WINDOW_TARGET_NOT_FOUND" };
    if (pages.length > 1) log(`cdp: ${pages.length} page targets match "${base}", using first`);
    const wsUrl = pages[0].webSocketDebuggerUrl;
    if (typeof wsUrl !== "string" || !wsUrl) return { ok: false, reason: "NO_WS_URL" };

    let session: CdpSession;
    try {
      session = await connect(wsUrl, 2000);
    } catch (e) {
      return { ok: false, reason: `CDP_CONNECT_FAIL:${String(e)}` };
    }

    try {
      // composer 在 newAgentChat 后异步挂载;同窗已有非空对话时要等到新空框出现,不能立刻 NON_EMPTY 放弃
      let focused = false;
      let draftMatched = false;
      let lastFocus = "NO_INPUT";
      for (let attempt = 0; attempt < 6 && !focused && !draftMatched; attempt++) {
        const r = String(await session.call("Runtime.evaluate", {
          expression: `(${COMPOSER_FOCUS_JS})(${JSON.stringify(prompt)})`, returnByValue: true,
        }).then((x) => x?.result?.value));
        lastFocus = r;
        if (r === "OK") {
          focused = true;
        } else if (r === "DRAFT") {
          draftMatched = true;
        } else if (r.startsWith("NON_EMPTY:")) {
          const existing = r.slice("NON_EMPTY:".length);
          if (existing === prompt.trim()) {
            draftMatched = true;
          } else {
            await sleep(800);
          }
        } else {
          await sleep(800);
        }
      }
      if (!focused && !draftMatched) {
        if (lastFocus.startsWith("NON_EMPTY:")) {
          return { ok: false, reason: `NON_EMPTY_INPUT:${lastFocus.slice("NON_EMPTY:".length).slice(0, 30)}` };
        }
        return { ok: false, reason: "NO_INPUT_AFTER_RETRY" };
      }

      if (focused) {
        await session.call("Input.insertText", { text: prompt });
        const v = String(await session.call("Runtime.evaluate", {
          expression: `(${COMPOSER_VERIFY_JS})(${JSON.stringify(prompt)})`, returnByValue: true,
        }).then((x) => x?.result?.value));
        if (v !== "OK") return { ok: false, reason: `VERIFY_FAIL:${v}` };
      }

      const e = String(await session.call("Runtime.evaluate", {
        expression: `(${COMPOSER_ENTER_JS})(${JSON.stringify(prompt)})`, returnByValue: true,
      }).then((x) => x?.result?.value));
      if (e !== "OK") return { ok: false, reason: `ENTER_FAIL:${e}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `CDP_EVAL_FAIL:${String(e)}` };
    } finally {
      session.close();
    }
  };
}
