/**
 * CDP 注入:通过 Chromium 远程调试端口操作 composer DOM,实现全自动提交。
 *
 * 前提:Cursor 以 --remote-debugging-port 与 --remote-debugging-address=127.0.0.1 启动(见 scripts/armada-cursor.sh)。
 * 端口只连 127.0.0.1;任何失败都返回 ok=false。自动提交时 CDP 不通必须 reject，禁止剪贴板假 ack。
 * 选窗见 pickCdpPage：文件夹名精确匹配，多窗口失败关闭。
 *
 * 真机实证(Cursor 3.15.19 / Electron 40)结论:
 * - composer 输入框: div.aislash-editor-input[contenteditable="true"](Agents 视图为 div.tiptap)
 * - 写入必须用 Input.insertText(浏览器真实输入管线);
 *   execCommand('insertText') 在刚挂载的空 composer 上会被编辑器模型对账吞掉(实测 VERIFY_FAIL)。
 * - 不做 DOM selectAllChildren+delete(编辑器错误合并,内容翻倍)。
 *   非空且等于本枪 prompt → 当草稿直接提交。
 *   非空但是 Armada 自己留下的(取消回灌 / 上次 insertText 未提交)→ Cmd/Ctrl+A + insertText 整框替换。
 *   外人草稿 → NON_EMPTY_INPUT,调用方不得剪贴板往里贴。
 * - 提交: 派发 keydown/keyup Enter(bubbles+composed),实证可触发 beforeSubmitPrompt。
 * - 同窗多个 composer 时优先空框(当前对话非空时 els[0] 是旧框,会误跳过回车)。
 * - 草稿匹配认完整 prompt 后缀(剪贴板追加后 prompt 在末尾);禁止 16 字任意位置子串。
 */

import { parseAskInspect, parsePlanInspect, planInspectToAsk, type AskInspect } from "./askDetect";
import { pickCdpPage, titleMatchesWorkspace, workspaceFolderName } from "./cdpPage";

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
  /** vscode.env.sessionId；缺省时不扫 stamp，选窗只走标题切段。 */
  windowId?: string;
}

export const WINDOW_STAMP_ATTR = "data-armada-window-id";
export const WINDOW_STAMP_READ_EXPRESSION =
  `document.documentElement.getAttribute(${JSON.stringify(WINDOW_STAMP_ATTR)})`;
export function windowStampWriteExpression(windowId: string): string {
  return `document.documentElement.setAttribute(${JSON.stringify(WINDOW_STAMP_ATTR)}, ${JSON.stringify(windowId)})`;
}

const SEL = 'div.aislash-editor-input[contenteditable="true"], div.tiptap[contenteditable="true"]';

/**
 * 同窗常有多个可见 composer(当前对话 + newAgentChat 新开的空框)。
 * 取 els[0] 会命中旧对话 → 误报 NON_EMPTY、只粘贴不回车。
 * 优先空框;否则完整 prompt 相等或以其结尾的草稿框(最长优先:残留+续聊长于「请继续」);
 * 再否则 reclaim 命中的 Armada 残留(取消回灌)。
 */
const VISIBLE_ELS = `Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(SEL)})).filter(function (e) { return e.offsetWidth > 0 && e.offsetHeight > 0; })`;

const DRAFT_HELPERS = `function armadaDraftHit(t, promptT) {
  if (!promptT) return false;
  var a = String(t || "").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");
  var b = String(promptT || "").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");
  return a === b || a.endsWith(b);
}
function armadaNorm(s) {
  return String(s || "").replace(/\\s+/g, " ").trim();
}
function armadaReclaimHit(t, reclaim) {
  if (!t || !reclaim || !reclaim.length) return false;
  var n = armadaNorm(t);
  for (var i = 0; i < reclaim.length; i++) {
    var r = armadaNorm(reclaim[i]);
    if (r && n === r) return true;
  }
  return false;
}`;

/** 2026-09-03 P1：芯片是 .ai-input-full-input-box 里的 .context-pill-image（不在 contenteditable，也不在输入框 8 层祖先内）。整页还有 transcript 药丸，必须限定本输入框。 */
const CHIP_HELPERS = `function armadaChipRoot(el) {
  var n = el;
  for (var i = 0; i < 16 && n; i++) {
    if (/\\bai-input-full-input-box\\b/.test(String(n.className || ""))) return n;
    n = n.parentElement;
  }
  return el;
}
function armadaChipCount(el) {
  var root = armadaChipRoot(el);
  return root.querySelectorAll ? root.querySelectorAll(".context-pill-image").length : 0;
}
function armadaFileMentionCount(el) {
  var root = armadaChipRoot(el);
  return root.querySelectorAll ? root.querySelectorAll('span.mention[data-typeahead-type="file"]').length : 0;
}
function armadaImageTarget(els) {
  var pristine = null, pasted = null, imageOnly = null, anyImage = null, anyFile = null;
  for (var i = 0; i < els.length; i++) {
    var t = els[i].innerText.trim();
    var imgs = armadaChipCount(els[i]);
    var files = armadaFileMentionCount(els[i]);
    if (imgs && !anyImage) anyImage = els[i];
    if (imgs && !files && !imageOnly) imageOnly = els[i];
    if (imgs && !files && !t && !pasted) pasted = els[i];
    if (files && !anyFile) anyFile = els[i];
    if (!t && !imgs && !files && !pristine) pristine = els[i];
  }
  return pristine || pasted || imageOnly || anyImage || anyFile || els[0];
}`;

/** 导出供单测直接 eval(注入 mock document) */
export const COMPOSER_FOCUS_JS = `function (prompt, reclaim) {
  ${DRAFT_HELPERS}
  var els = ${VISIBLE_ELS};
  if (!els.length) return "NO_INPUT";
  var promptT = String(prompt || "").trim();
  var empty = null, matched = null, matchedLen = -1, owned = null;
  for (var i = 0; i < els.length; i++) {
    var t = els[i].innerText.trim();
    if (!t) { if (!empty) empty = els[i]; }
    else if (armadaDraftHit(t, promptT) && t.length > matchedLen) { matched = els[i]; matchedLen = t.length; }
    else if (!owned && armadaReclaimHit(t, reclaim)) { owned = els[i]; }
  }
  if (empty) { empty.focus(); return "OK"; }
  if (matched) { matched.focus(); return "DRAFT"; }
  if (owned) { owned.focus(); return "OWNED"; }
  return "NON_EMPTY:" + els[0].innerText.trim();
}`;

export const COMPOSER_VERIFY_JS = `function (prompt) {
  ${DRAFT_HELPERS}
  var els = ${VISIBLE_ELS};
  var promptT = String(prompt || "").trim();
  for (var i = 0; i < els.length; i++) {
    var t = els[i].innerText.trim();
    if (armadaDraftHit(t, promptT)) return "OK";
  }
  if (!els.length) return "NO_INPUT";
  return "MISMATCH:" + els[0].innerText.slice(0, 40);
}`;

export const COMPOSER_CHIP_COUNT_JS = `function () {
  ${CHIP_HELPERS}
  var els = ${VISIBLE_ELS};
  if (!els.length) return 0;
  return armadaChipCount(armadaImageTarget(els));
}`;

export const COMPOSER_FILE_MENTION_COUNT_JS = `function () {
  ${CHIP_HELPERS}
  var els = ${VISIBLE_ELS};
  if (!els.length) return 0;
  return armadaFileMentionCount(armadaImageTarget(els));
}`;

export const COMPOSER_CLICK_FILE_MENTION_JS = `function (needle) {
  var menu = document.querySelector(".mentions-menu");
  if (!menu) return "NO_MENU";
  var items = Array.prototype.slice.call(menu.querySelectorAll("[class*='menu-item'], [role='option']"));
  var want = String(needle || "");
  for (var i = 0; i < items.length; i++) {
    if (String(items[i].innerText || "").indexOf(want) >= 0) {
      items[i].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      items[i].dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      items[i].click();
      return "OK";
    }
  }
  return items.length ? "NO_MATCH" : "NO_ITEM";
}`;

export const COMPOSER_FOCUS_IMAGE_JS = `function () {
  ${CHIP_HELPERS}
  var els = ${VISIBLE_ELS};
  if (!els.length) return "NO_INPUT";
  var el = armadaImageTarget(els);
  el.focus();
  return "OK";
}`;
export const COMPOSER_ENTER_JS = `function (prompt) {
  ${CHIP_HELPERS}
  ${DRAFT_HELPERS}
  var els = ${VISIBLE_ELS};
  if (!els.length) return "NO_INPUT";
  var promptT = String(prompt || "").trim();
  var el = null, matchedLen = -1;
  for (var i = 0; i < els.length; i++) {
    var t = els[i].innerText.trim();
    if (armadaDraftHit(t, promptT) && t.length > matchedLen) { el = els[i]; matchedLen = t.length; }
  }
  if (!el) el = armadaImageTarget(els);
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

async function nap(ms: number, sleep?: (n: number) => Promise<void>): Promise<void> {
  if (sleep) {
    await sleep(ms);
    return;
  }
  await new Promise((r) => setTimeout(r, ms));
}

export async function fetchJsonWithRetry(
  fetchJson: (url: string, timeoutMs: number) => Promise<unknown>,
  url: string,
  timeoutMs: number,
  opts?: { tries?: number; gapMs?: number; sleep?: (n: number) => Promise<void> },
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const tries = opts?.tries ?? 3;
  const gapMs = opts?.gapMs ?? 400;
  for (let i = 0; i < tries; i++) {
    try {
      return { ok: true, body: await fetchJson(url, timeoutMs) };
    } catch {
      if (i === tries - 1) return { ok: false };
      await nap(gapMs, opts?.sleep);
    }
  }
  return { ok: false };
}

/** 口通不通：GET /json 300ms。不 pick workspace page（残实例是口都不通）。 */
export async function probeCdpReady(opts: {
  port: number;
  fetchJson?: (url: string, timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<boolean> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  try {
    const body = await fetchJson(`http://127.0.0.1:${opts.port}/json`, opts.timeoutMs ?? 300);
    return Array.isArray(body);
  } catch {
    return false;
  }
}

/** 注入前、注册、心跳都走这条：9222 闪断重试三次。一次超时不再把 cdpReady 打成 false。 */
export async function probeCdpReadyForInject(opts: {
  port: number;
  fetchJson?: (url: string, timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
  sleep?: (n: number) => Promise<void>;
}): Promise<boolean> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const got = await fetchJsonWithRetry(
    fetchJson,
    `http://127.0.0.1:${opts.port}/json`,
    opts.timeoutMs ?? 300,
    { sleep: opts.sleep },
  );
  return got.ok && Array.isArray(got.body);
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

const ASK_ESC = /[.*+?^${}()|[\\]\\\\]/g;

/** Skip: aria/文案 /skip/i，或 `.composer-skip-button`。Other: 祖先 `option-freeform`。都没有才回退「最后一个 letter」。 */
export const ASK_LETTER_BUTTONS_JS = `function armadaLetterButtons(btns, bar) {
  function skipish(b) {
    var aria = "";
    try { aria = b && b.getAttribute ? String(b.getAttribute("aria-label") || "") : ""; } catch (e) {}
    var text = String((b && b.innerText) || "");
    return /skip/i.test(aria) || /skip/i.test(text);
  }
  function isFreeform(b) {
    var n = b;
    for (var i = 0; i < 6 && n; i++) {
      var cls = n.className != null ? String(n.className) : "";
      if (/\\bcomposer-questionnaire-toolbar-option-freeform\\b/.test(cls)) return true;
      n = n.parentElement;
    }
    return false;
  }
  var skipBtn = null;
  try { skipBtn = bar && bar.querySelector ? bar.querySelector(".composer-skip-button") : null; } catch (e) {}
  if (!btns.length) return { real: [], skip: null, skip_unidentified: false };
  if (btns.length === 1) return { real: btns.slice(), skip: skipBtn, skip_unidentified: false };
  var real = [];
  var skip = null;
  var hasFreeform = false;
  for (var i = 0; i < btns.length; i++) {
    if (skipish(btns[i])) { if (!skip) skip = btns[i]; continue; }
    if (isFreeform(btns[i])) hasFreeform = true;
    real.push(btns[i]);
  }
  if (skip) return { real: real, skip: skip, skip_unidentified: false };
  if (skipBtn) return { real: real, skip: skipBtn, skip_unidentified: false };
  if (hasFreeform) return { real: real, skip: skipBtn, skip_unidentified: false };
  if (btns.length >= 2) return { real: btns.slice(0, -1), skip: btns[btns.length - 1], skip_unidentified: false };
  return { real: btns.slice(), skip: null, skip_unidentified: true };
}
function armadaIsFreeformLetter(b) {
  var n = b;
  for (var i = 0; i < 6 && n; i++) {
    var cls = n.className != null ? String(n.className) : "";
    if (/\\bcomposer-questionnaire-toolbar-option-freeform\\b/.test(cls)) return true;
    n = n.parentElement;
  }
  return false;
}`;

/** Questions 探测。cid：toolbar 祖先 → 包含 toolbar 的 [data-composer-id] → 唯一可见输入框祖先（Windows 控件常不在 composer 树上）。 */
export const ASK_INSPECT_JS = `function () {
  ${ASK_LETTER_BUTTONS_JS}
  function composerIdFromNode(start) {
    var n = start;
    for (var i = 0; i < 40 && n; i++) {
      var id = n.getAttribute && n.getAttribute("data-composer-id");
      if (id && String(id).trim()) return String(id).trim();
      n = n.parentElement;
    }
    return "";
  }
  var bar = document.querySelector(".composer-questionnaire-toolbar");
  if (!bar) return { present: false };
  var conversation_id = composerIdFromNode(bar);
  if (!conversation_id) {
    var hosts = document.querySelectorAll("[data-composer-id]");
    for (var h = 0; h < hosts.length; h++) {
      if (hosts[h].contains && hosts[h].contains(bar)) {
        conversation_id = String(hosts[h].getAttribute("data-composer-id") || "").trim();
        if (conversation_id) break;
      }
    }
  }
  if (!conversation_id) {
    var els = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(SEL)})).filter(function (e) {
      return e.offsetWidth > 0 && e.offsetHeight > 0;
    });
    var seen = "";
    var unique = true;
    for (var i = 0; i < els.length; i++) {
      var cid = composerIdFromNode(els[i]);
      if (!cid) continue;
      if (!seen) seen = cid;
      else if (seen !== cid) unique = false;
    }
    if (unique && seen) conversation_id = seen;
  }
  var btns = Array.prototype.slice.call(bar.querySelectorAll("button.composer-questionnaire-toolbar-option-letter"));
  var classified = armadaLetterButtons(btns, bar);
  var real = classified.real;
  var skip = classified.skip;
  var letters = real.map(function (b) { return String(b.innerText || "").trim(); });
  function esc(s) { return String(s || "").replace(${ASK_ESC}, "\\\\$&"); }
  var raw = String(bar.innerText || "").replace(/\\s+/g, " ").trim();
  var prompt = raw.replace(/^Questions\\s+\\d+\\s+of\\s+\\d+\\s+/i, "").replace(/^\\d+\\.\\s*/, "");
  if (letters[0]) {
    var cut = prompt.search(new RegExp("\\\\s+" + esc(letters[0]) + "\\\\s"));
    if (cut > 0) prompt = prompt.slice(0, cut);
  }
  prompt = prompt.replace(/\\s+Skip\\s+Esc\\s+Continue[\\s\\S]*$/i, "").trim();
  var options = [];
  for (var i = 0; i < letters.length; i++) {
    var L = letters[i];
    var next = i + 1 < letters.length ? letters[i + 1] : (skip ? String(skip.innerText || "").trim() : "");
    var text = L;
    if (L && next) {
      var m = raw.match(new RegExp("(?:^|\\\\s)" + esc(L) + "\\\\s+([\\\\s\\\\S]*?)(?=\\\\s+" + esc(next) + "(?:\\\\s|$)|$)"));
      if (m && m[1]) text = m[1].replace(/\\s+Skip\\s+Esc\\s+Continue[\\s\\S]*$/i, "").trim() || L;
    }
    var opt = { id: L.toLowerCase(), label: L, text: text };
    if (armadaIsFreeformLetter(real[i])) {
      opt.freeform = true;
      if (!text || text === L) opt.text = "Other...";
    }
    options.push(opt);
  }
  var out = { present: true, prompt: prompt || "Questions", options: options, conversation_id: conversation_id };
  if (classified.skip_unidentified) out.skip_unidentified = true;
  return out;
}`;

/** 点目标字母；禁止点 Skip 控件。 */
export const ASK_CLICK_LETTER_JS = `function (letter) {
  ${ASK_LETTER_BUTTONS_JS}
  var bar = document.querySelector(".composer-questionnaire-toolbar");
  if (!bar) return "GONE";
  var btns = Array.prototype.slice.call(bar.querySelectorAll("button.composer-questionnaire-toolbar-option-letter"));
  var real = armadaLetterButtons(btns, bar).real;
  var want = String(letter || "").trim().toUpperCase();
  var btn = null;
  for (var i = 0; i < real.length; i++) {
    if (String(real[i].innerText || "").trim().toUpperCase() === want) { btn = real[i]; break; }
  }
  if (!btn) return "NO_LETTER";
  if (typeof bar.scrollIntoView === "function") bar.scrollIntoView({ block: "center" });
  if (typeof btn.focus === "function") btn.focus();
  if (typeof btn.click === "function") btn.click();
  return "OK";
}`;

/** 点 Cursor Skip 控件 `.composer-skip-button`；禁止点字母、禁止先 Escape。 */
export const ASK_CLICK_SKIP_JS = `function () {
  ${ASK_LETTER_BUTTONS_JS}
  var bar = document.querySelector(".composer-questionnaire-toolbar");
  if (!bar) return "GONE";
  var btns = Array.prototype.slice.call(bar.querySelectorAll("button.composer-questionnaire-toolbar-option-letter"));
  var classified = armadaLetterButtons(btns, bar);
  var btn = classified.skip;
  if (!btn) {
    try { btn = bar.querySelector(".composer-skip-button"); } catch (e) {}
  }
  if (!btn) return "NO_SKIP";
  if (typeof bar.scrollIntoView === "function") bar.scrollIntoView({ block: "center" });
  if (typeof btn.focus === "function") btn.focus();
  if (typeof btn.click === "function") btn.click();
  return "OK";
}`;

/** 点 Other 字母并聚焦自由输入。禁止走 composer insertText。 */
export const ASK_FOCUS_FREEFORM_JS = `function () {
  var bar = document.querySelector(".composer-questionnaire-toolbar");
  if (!bar) return "GONE";
  var input = bar.querySelector("textarea.composer-questionnaire-toolbar-freeform-input");
  if (!input) return "NO_FREEFORM";
  var opt = input.closest ? input.closest(".composer-questionnaire-toolbar-option-freeform") : input.parentElement;
  var letter = opt && opt.querySelector ? opt.querySelector("button.composer-questionnaire-toolbar-option-letter") : null;
  if (letter && typeof letter.click === "function") letter.click();
  if (typeof input.focus === "function") input.focus();
  return "OK";
}`;

/** Mac：`[data-component=split-button][data-tone=plan]`。Windows 真机 2026-09-15：无 data-tone，Build 在 class `ui-split-button` 的普通 BUTTON。闸是主按钮文案 `Build`，不含 `Building`。 */
const PLAN_FIND_BUILD_JS = `function planIsBuildLabel(t) {
  var s = String(t || "").replace(/\\s+/g, " ").trim();
  return /^Build(\\s|$)/.test(s);
}
function planCardOf(el) {
  var card = el;
  for (var c = 0; c < 40 && card; c++) {
    if (card.getAttribute && card.getAttribute("data-component") === "transcript-card-root") return card;
    card = card.parentElement;
  }
  return null;
}
function planFindBuildInCard(card) {
  if (!card) return null;
  var split = card.querySelector ? card.querySelector("[data-component=split-button][data-tone=plan]") : null;
  if (split && split.querySelectorAll) {
    var macBtns = split.querySelectorAll("button");
    for (var i = 0; i < macBtns.length; i++) {
      if (planIsBuildLabel(macBtns[i].innerText)) return macBtns[i];
    }
  }
  if (!card.querySelectorAll) return null;
  var winBtns = card.querySelectorAll("button");
  for (var j = 0; j < winBtns.length; j++) {
    if (!planIsBuildLabel(winBtns[j].innerText)) continue;
    var p = winBtns[j].parentElement;
    var cls = p && p.className != null ? String(p.className) : "";
    if (/\\bui-split-button\\b/.test(cls)) return winBtns[j];
  }
  return null;
}
function planFindLive(doc) {
  var names = doc.querySelectorAll ? doc.querySelectorAll("[data-testid=composer-plan-filename]") : [];
  var lastName = null;
  var lastBtn = null;
  for (var i = 0; i < names.length; i++) {
    var btn = planFindBuildInCard(planCardOf(names[i]));
    if (btn) { lastName = names[i]; lastBtn = btn; }
  }
  return { name: lastName, btn: lastBtn };
}
function planFindBuild(doc) {
  return planFindLive(doc).btn;
}`;

/** Created Plan 探测。闸是 Build 主按钮，不是 filename / View Plan（点过 Build 后卡片仍可能留着）。Mac middleware + Windows Win Destop 2026-09-15。 */
export const PLAN_INSPECT_JS = `function () {
  ${PLAN_FIND_BUILD_JS}
  var hit = planFindLive(document);
  var name = hit.name;
  var btn = hit.btn;
  if (!name || !btn) return { present: false };
  var filename = String(name.innerText || "").replace(/\\s+/g, " ").trim() || "Plan";
  var conversation_id = "";
  var overview = "";
  var n = name;
  for (var i = 0; i < 40 && n; i++) {
    var id = n.getAttribute && n.getAttribute("data-composer-id");
    if (id && String(id).trim() && !conversation_id) conversation_id = String(id).trim();
    var comp = n.getAttribute && n.getAttribute("data-component");
    if (comp === "transcript-card-root" && !overview) {
      overview = String(n.innerText || "").replace(/\\s+/g, " ").trim()
        .replace(/^Created Plan\\s*/i, "")
        .replace(filename, "")
        .replace(/\\s*View Plan[\\s\\S]*$/i, "")
        .trim();
    }
    n = n.parentElement;
  }
  return { present: true, filename: filename, overview: overview, conversation_id: conversation_id };
}`;

/** 点 Build。真机 2026-09-15 Mac/Windows：element.click() 会启动 Implement the plan。不要再派 Enter。 */
export const PLAN_CLICK_BUILD_JS = `function () {
  ${PLAN_FIND_BUILD_JS}
  var btn = planFindBuild(document);
  if (!btn) return "GONE";
  var host = btn.parentElement || btn;
  if (typeof host.scrollIntoView === "function") host.scrollIntoView({ block: "center" });
  else if (typeof btn.scrollIntoView === "function") btn.scrollIntoView({ block: "center" });
  if (typeof btn.focus === "function") btn.focus();
  if (typeof btn.click === "function") btn.click();
  return "OK";
}`;

export type AskCdpInspect = AskInspect;

async function readWindowStamp(session: CdpSession): Promise<string | null> {
  try {
    const v = await session.call("Runtime.evaluate", {
      expression: WINDOW_STAMP_READ_EXPRESSION,
      returnByValue: true,
    });
    const val = v?.result?.value;
    return typeof val === "string" && val ? val : null;
  } catch {
    return null;
  }
}

async function connectWorkspacePage(
  deps: Required<Pick<CdpSubmitterDeps, "port">> & CdpSubmitterDeps,
  workspaceRoot: string,
): Promise<{ ok: true; session: CdpSession } | { ok: false; reason: string }> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const connect = deps.connect ?? defaultConnect;
  const log = deps.log ?? (() => {});
  const listed = await fetchJsonWithRetry(
    fetchJson,
    `http://127.0.0.1:${deps.port}/json`,
    1500,
    { sleep: deps.sleep },
  );
  if (!listed.ok) return { ok: false, reason: "CDP_UNREACHABLE" };
  const targets = listed.body as any[];
  const windowId = typeof deps.windowId === "string" ? deps.windowId.trim() : "";
  if (windowId) {
    const pages = (Array.isArray(targets) ? targets : []).filter(
      (t) => t?.type === "page" && typeof t.webSocketDebuggerUrl === "string" && t.webSocketDebuggerUrl,
    );
    const opened: { session: CdpSession; stamp: string | null; title: string }[] = [];
    for (const t of pages) {
      try {
        const session = await connect(String(t.webSocketDebuggerUrl), 2000);
        const stamp = await readWindowStamp(session);
        opened.push({
          session,
          stamp,
          title: typeof t.title === "string" ? t.title : "",
        });
      } catch {
        // 连不上或读失败当未盖章，不据此 AMBIGUOUS
      }
    }
    const closeExcept = (keep: CdpSession | null) => {
      for (const o of opened) {
        if (o.session !== keep) o.session.close();
      }
    };
    const writeStamp = async (session: CdpSession) => {
      try {
        await session.call("Runtime.evaluate", {
          expression: windowStampWriteExpression(windowId),
          returnByValue: true,
        });
      } catch (e) {
        log(`window stamp write failed: ${String(e)}`);
      }
    };
    const hits = opened.filter((o) => o.stamp === windowId);
    if (hits.length === 1) {
      closeExcept(hits[0]!.session);
      return { ok: true, session: hits[0]!.session };
    }
    if (hits.length > 1) {
      closeExcept(null);
      return { ok: false, reason: "WINDOW_TARGET_AMBIGUOUS" };
    }
    const titleHits = opened.filter((o) => titleMatchesWorkspace(o.title, workspaceFolderName(workspaceRoot)));
    const unstamped = titleHits.filter((o) => !o.stamp);
    if (unstamped.length === 1) {
      closeExcept(unstamped[0]!.session);
      await writeStamp(unstamped[0]!.session);
      return { ok: true, session: unstamped[0]!.session };
    }
    closeExcept(null);
    if (unstamped.length > 1) return { ok: false, reason: "WINDOW_TARGET_AMBIGUOUS" };
    return { ok: false, reason: "WINDOW_TARGET_NOT_FOUND" };
  }
  const picked = pickCdpPage(targets, workspaceRoot);
  if (!picked.ok) return picked;
  try {
    const session = await connect(picked.wsUrl, 2000);
    return { ok: true, session };
  } catch (e) {
    return { ok: false, reason: `CDP_CONNECT_FAIL:${String(e)}` };
  }
}

async function dispatchKey(session: CdpSession, key: "Enter" | "Escape"): Promise<void> {
  const code = key === "Enter" ? "Enter" : "Escape";
  const vk = key === "Enter" ? 13 : 27;
  await session.call("Input.dispatchKeyEvent", {
    type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  await session.call("Input.dispatchKeyEvent", {
    type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}

export function createAskQuestionDriver(deps: CdpSubmitterDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function inspect(workspaceRoot: string): Promise<AskCdpInspect> {
    const hit = await connectWorkspacePage(deps, workspaceRoot);
    if (!hit.ok) return { unknown: true, reason: hit.reason };
    try {
      const ask = parseAskInspect(await hit.session.call("Runtime.evaluate", {
        expression: `(${ASK_INSPECT_JS})()`, returnByValue: true,
      }).then((x) => x?.result?.value));
      if (ask.present && ask.options.length > 0) return ask;
      return planInspectToAsk(parsePlanInspect(
        await hit.session.call("Runtime.evaluate", {
          expression: `(${PLAN_INSPECT_JS})()`, returnByValue: true,
        }).then((x) => x?.result?.value),
      ));
    } catch (e) {
      return { unknown: true, reason: `CDP_EVAL_FAIL:${String(e)}` };
    } finally {
      hit.session.close();
    }
  }

  async function submit(
    workspaceRoot: string,
    action: "continue" | "skip" | "freeform",
    letter?: string,
    kind?: "plan",
    text?: string,
  ): Promise<CdpSubmitResult> {
    const hit = await connectWorkspacePage(deps, workspaceRoot);
    if (!hit.ok) return { ok: false, reason: hit.reason };
    try {
      if (action === "continue" && kind === "plan") {
        const clicked = String(await hit.session.call("Runtime.evaluate", {
          expression: `(${PLAN_CLICK_BUILD_JS})()`,
          returnByValue: true,
        }).then((x) => x?.result?.value));
        if (clicked !== "OK") return { ok: false, reason: clicked === "GONE" ? "ASK_WIDGET_NOT_FOUND" : "ASK_INVALID_OPTION" };
        for (let i = 0; i < 8; i++) {
          const v = await hit.session.call("Runtime.evaluate", {
            expression: `(${PLAN_INSPECT_JS})()`, returnByValue: true,
          }).then((x) => x?.result?.value);
          if (!v || v.present !== true) return { ok: true };
          await sleep(400);
        }
        return { ok: false, reason: "ASK_SUBMIT_FAILED" };
      }
      if (action === "freeform") {
        const focused = String(await hit.session.call("Runtime.evaluate", {
          expression: `(${ASK_FOCUS_FREEFORM_JS})()`,
          returnByValue: true,
        }).then((x) => x?.result?.value));
        if (focused !== "OK") return { ok: false, reason: focused === "GONE" ? "ASK_WIDGET_NOT_FOUND" : "ASK_INVALID_OPTION" };
        await hit.session.call("Input.insertText", { text: String(text || "") });
        await dispatchKey(hit.session, "Enter");
      } else if (action === "continue") {
        const clicked = String(await hit.session.call("Runtime.evaluate", {
          expression: `(${ASK_CLICK_LETTER_JS})(${JSON.stringify(String(letter || "").toUpperCase())})`,
          returnByValue: true,
        }).then((x) => x?.result?.value));
        if (clicked !== "OK") return { ok: false, reason: clicked === "GONE" ? "ASK_WIDGET_NOT_FOUND" : "ASK_INVALID_OPTION" };
        await dispatchKey(hit.session, "Enter");
      } else {
        const clicked = String(await hit.session.call("Runtime.evaluate", {
          expression: `(${ASK_CLICK_SKIP_JS})()`,
          returnByValue: true,
        }).then((x) => x?.result?.value));
        if (clicked === "GONE") return { ok: false, reason: "ASK_WIDGET_NOT_FOUND" };
        if (clicked !== "OK") await dispatchKey(hit.session, "Escape");
      }
      for (let i = 0; i < 8; i++) {
        const v = await hit.session.call("Runtime.evaluate", {
          expression: `(${ASK_INSPECT_JS})()`, returnByValue: true,
        }).then((x) => x?.result?.value);
        if (!v || v.present !== true) return { ok: true };
        await sleep(400);
      }
      return { ok: false, reason: "ASK_SUBMIT_FAILED" };
    } catch (e) {
      return { ok: false, reason: `CDP_EVAL_FAIL:${String(e)}` };
    } finally {
      hit.session.close();
    }
  }

  return { inspect, submit };
}

export type CdpSubmitOpts = { reclaim?: string[] };

function normDraft(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function reclaimHit(existing: string, reclaim?: string[]): boolean {
  if (!existing || !reclaim?.length) return false;
  const n = normDraft(existing);
  return reclaim.some((r) => {
    const x = normDraft(r);
    return !!x && x === n;
  });
}

/**
 * Input.insertText 遇到换行即停，后文不会进入 composer。
 * 这个框里换行是 Shift+Enter，裸 Enter 是发送。按行写入，不改提示词、不改 DOM。
 */
async function insertComposerText(session: CdpSession, text: string): Promise<void> {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await shiftEnter(session);
    const line = lines[i] ?? "";
    if (line) await session.call("Input.insertText", { text: line });
  }
}

async function shiftEnter(session: CdpSession): Promise<void> {
  const key = {
    modifiers: 8,
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await session.call("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await session.call("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

/** 真机 2026-09-18：Cmd/Ctrl+A + Input.insertText 整框替换，不翻倍。禁止 selectAllChildren+delete。 */
async function selectAllComposer(session: CdpSession): Promise<void> {
  const meta = process.platform === "win32" ? 2 : 4;
  await session.call("Input.dispatchKeyEvent", {
    type: "keyDown", modifiers: meta, key: "a", code: "KeyA", windowsVirtualKeyCode: 65,
  });
  await session.call("Input.dispatchKeyEvent", {
    type: "keyUp", modifiers: meta, key: "a", code: "KeyA", windowsVirtualKeyCode: 65,
  });
}

export function createCdpSubmitter(deps: CdpSubmitterDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  return async function submit(workspaceRoot: string, prompt: string, opts?: CdpSubmitOpts): Promise<CdpSubmitResult> {
    const hit = await connectWorkspacePage(deps, workspaceRoot);
    if (!hit.ok) return hit;
    const session = hit.session;
    const reclaim = opts?.reclaim ?? [];

    try {
      // composer 在 newAgentChat 后异步挂载;同窗已有非空对话时要等到新空框出现,不能立刻 NON_EMPTY 放弃
      let focused = false;
      let draftMatched = false;
      let owned = false;
      let lastFocus = "NO_INPUT";
      for (let attempt = 0; attempt < 6 && !focused && !draftMatched && !owned; attempt++) {
        const r = String(await session.call("Runtime.evaluate", {
          expression: `(${COMPOSER_FOCUS_JS})(${JSON.stringify(prompt)}, ${JSON.stringify(reclaim)})`,
          returnByValue: true,
        }).then((x) => x?.result?.value));
        lastFocus = r;
        if (r === "OK") {
          focused = true;
        } else if (r === "DRAFT") {
          draftMatched = true;
        } else if (r === "OWNED") {
          owned = true;
        } else if (r.startsWith("NON_EMPTY:")) {
          const existing = r.slice("NON_EMPTY:".length);
          if (existing === prompt.trim()) {
            draftMatched = true;
          } else if (reclaimHit(existing, reclaim)) {
            owned = true;
          } else {
            await sleep(800);
          }
        } else {
          await sleep(800);
        }
      }
      if (!focused && !draftMatched && !owned) {
        if (lastFocus.startsWith("NON_EMPTY:")) {
          return { ok: false, reason: `NON_EMPTY_INPUT:${lastFocus.slice("NON_EMPTY:".length).slice(0, 30)}` };
        }
        return { ok: false, reason: "NO_INPUT_AFTER_RETRY" };
      }

      if (owned || focused) {
        if (owned) await selectAllComposer(session);
        await insertComposerText(session, prompt);
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

export type ImagePasteStep = { bytes: Buffer; mime: string };

export function createImagePaster(deps: CdpSubmitterDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const meta = process.platform === "win32" ? 2 : 4;

  return async function paste(
    workspaceRoot: string,
    prompt: string,
    steps: ImagePasteStep[],
    writeClipboard: (bytes: Buffer, mime: string) => void | Promise<void>,
    autoSubmit: boolean,
  ): Promise<CdpSubmitResult> {
    const hit = await connectWorkspacePage(deps, workspaceRoot);
    if (!hit.ok) return hit;
    const session = hit.session;

    try {
      let focused = false;
      for (let attempt = 0; attempt < 6 && !focused; attempt++) {
        const r = String(await session.call("Runtime.evaluate", {
          expression: `(${COMPOSER_FOCUS_IMAGE_JS})()`, returnByValue: true,
        }).then((x) => x?.result?.value));
        if (r === "OK") focused = true;
        else await sleep(800);
      }
      if (!focused) return { ok: false, reason: "NO_INPUT_AFTER_RETRY" };

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        await writeClipboard(step.bytes, step.mime);
        let okChip = false;
        // 先数芯片：已经贴上的不得再 Cmd+V（探测失败也不连贴三张）。
        for (let retry = 0; retry < 3 && !okChip; retry++) {
          const n = Number(await session.call("Runtime.evaluate", {
            expression: `(${COMPOSER_CHIP_COUNT_JS})()`, returnByValue: true,
          }).then((x) => x?.result?.value));
          if (n >= i + 1) { okChip = true; break; }
          await session.call("Runtime.evaluate", {
            expression: `(${COMPOSER_FOCUS_IMAGE_JS})()`, returnByValue: true,
          });
          await session.call("Input.dispatchKeyEvent", {
            type: "keyDown", modifiers: meta, key: "v", code: "KeyV", windowsVirtualKeyCode: 86,
          });
          await session.call("Input.dispatchKeyEvent", {
            type: "keyUp", modifiers: meta, key: "v", code: "KeyV", windowsVirtualKeyCode: 86,
          });
          await sleep(400);
        }
        if (!okChip) {
          const n = Number(await session.call("Runtime.evaluate", {
            expression: `(${COMPOSER_CHIP_COUNT_JS})()`, returnByValue: true,
          }).then((x) => x?.result?.value));
          okChip = n >= i + 1;
        }
        if (!okChip) return { ok: false, reason: `CHIP_COUNT:${i + 1}` };
      }

      if (prompt.trim()) {
        await insertComposerText(session, prompt);
        const v = String(await session.call("Runtime.evaluate", {
          expression: `(${COMPOSER_VERIFY_JS})(${JSON.stringify(prompt)})`, returnByValue: true,
        }).then((x) => x?.result?.value));
        if (v !== "OK") return { ok: false, reason: `VERIFY_FAIL:${v}` };
      }
      if (autoSubmit) {
        const e = String(await session.call("Runtime.evaluate", {
          expression: `(${COMPOSER_ENTER_JS})(${JSON.stringify(prompt)})`, returnByValue: true,
        }).then((x) => x?.result?.value));
        if (e !== "OK") return { ok: false, reason: `ENTER_FAIL:${e}` };
      }
      return { ok: true };
    } catch (e) {
      log(`image paste fail: ${String(e)}`);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "CLIPBOARD_TIMEOUT" || msg.endsWith("CLIPBOARD_TIMEOUT")) {
        return { ok: false, reason: "CLIPBOARD_TIMEOUT" };
      }
      return { ok: false, reason: `CDP_EVAL_FAIL:${String(e)}` };
    } finally {
      session.close();
    }
  };
}

export function createFileMentionPaster(deps: CdpSubmitterDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});

  return async function paste(
    workspaceRoot: string,
    needles: string[],
  ): Promise<CdpSubmitResult> {
    const hit = await connectWorkspacePage(deps, workspaceRoot);
    if (!hit.ok) return hit;
    const session = hit.session;

    try {
      let focused = false;
      for (let attempt = 0; attempt < 6 && !focused; attempt++) {
        const r = String(await session.call("Runtime.evaluate", {
          expression: `(${COMPOSER_FOCUS_IMAGE_JS})()`, returnByValue: true,
        }).then((x) => x?.result?.value));
        if (r === "OK") focused = true;
        else await sleep(800);
      }
      if (!focused) return { ok: false, reason: "NO_INPUT_AFTER_RETRY" };
      // Inbox files just landed; Windows typeahead lags (hub: FILE_MENTION_FAILED then retry ok).
      await sleep(800);

      const press = async (key: string, code: string, vk: number) => {
        await session.call("Input.dispatchKeyEvent", {
          type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        });
        await session.call("Input.dispatchKeyEvent", {
          type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        });
      };
      const typeAndClick = async (needle: string) => {
        await session.call("Input.insertText", { text: "@" });
        await sleep(400);
        await session.call("Input.insertText", { text: needle });
        await sleep(700);
        let clicked = "NO_MENU";
        for (let attempt = 0; attempt < 8 && clicked !== "OK"; attempt++) {
          clicked = String(await session.call("Runtime.evaluate", {
            expression: `(${COMPOSER_CLICK_FILE_MENTION_JS})(${JSON.stringify(needle)})`, returnByValue: true,
          }).then((x) => x?.result?.value));
          if (clicked !== "OK") await sleep(400);
        }
        return clicked;
      };
      // One retype for the whole paste. A just-written inbox file often has no
      // .mentions-menu until the workspace index catches up (~15s). A second
      // full dispatch then succeeds; do that wait here so the run is not rejected.
      let retypesLeft = 1;

      for (let i = 0; i < needles.length; i++) {
        const needle = needles[i]!;
        let clicked = await typeAndClick(needle);
        if (clicked !== "OK" && retypesLeft > 0) {
          retypesLeft -= 1;
          log(`file mention menu not ready, retyping needle=${needle}`);
          await press("Escape", "Escape", 27);
          for (let n = 0; n < 1 + needle.length; n++) await press("Backspace", "Backspace", 8);
          await sleep(10_000);
          clicked = await typeAndClick(needle);
        }
        if (clicked !== "OK") return { ok: false, reason: `MENTION_CLICK:${clicked}` };
        let okChip = false;
        const countChip = async () => {
          for (let retry = 0; retry < 5 && !okChip; retry++) {
            const n = Number(await session.call("Runtime.evaluate", {
              expression: `(${COMPOSER_FILE_MENTION_COUNT_JS})()`, returnByValue: true,
            }).then((x) => x?.result?.value));
            if (n >= i + 1) { okChip = true; break; }
            await sleep(300);
          }
        };
        await countChip();
        // Click can return OK while the chip node is still missing. Same one-shot
        // wait as the menu retype; do not backspace — the query text is already gone.
        if (!okChip && retypesLeft > 0) {
          retypesLeft -= 1;
          log(`file mention chip not ready, waiting needle=${needle}`);
          await sleep(10_000);
          await countChip();
        }
        if (!okChip) return { ok: false, reason: `FILE_MENTION_COUNT:${i + 1}` };
      }
      return { ok: true };
    } catch (e) {
      log(`file mention fail: ${String(e)}`);
      return { ok: false, reason: `CDP_EVAL_FAIL:${String(e)}` };
    } finally {
      session.close();
    }
  };
}

export function createComposerFinisher(deps: CdpSubmitterDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  return async function finish(
    workspaceRoot: string,
    prompt: string,
    autoSubmit: boolean,
  ): Promise<CdpSubmitResult> {
    const hit = await connectWorkspacePage(deps, workspaceRoot);
    if (!hit.ok) return hit;
    const session = hit.session;
    try {
      await session.call("Runtime.evaluate", {
        expression: `(${COMPOSER_FOCUS_IMAGE_JS})()`, returnByValue: true,
      });
      if (prompt.trim()) {
        await insertComposerText(session, prompt);
        await sleep(200);
        const v = String(await session.call("Runtime.evaluate", {
          expression: `(${COMPOSER_VERIFY_JS})(${JSON.stringify(prompt)})`, returnByValue: true,
        }).then((x) => x?.result?.value));
        if (v !== "OK") return { ok: false, reason: `VERIFY_FAIL:${v}` };
      }
      if (autoSubmit) {
        const e = String(await session.call("Runtime.evaluate", {
          expression: `(${COMPOSER_ENTER_JS})(${JSON.stringify(prompt)})`, returnByValue: true,
        }).then((x) => x?.result?.value));
        if (e !== "OK") return { ok: false, reason: `ENTER_FAIL:${e}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `CDP_EVAL_FAIL:${String(e)}` };
    } finally {
      session.close();
    }
  };
}
