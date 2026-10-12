import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { ChatgptPage } from "./chatgptDrive";
import type { ChatgptControl } from "./chatgptDesktop";

const PORT = 9334;

const CONTROLS_JS = `(() => {
  const nodes = [...document.querySelectorAll("button, textarea, [role=textbox], [role=menuitem], [contenteditable=true]")];
  return nodes.map((el) => {
    const r = el.getBoundingClientRect();
    const name = (el.getAttribute("aria-label") || el.innerText || "").replace(/\\s+/g, " ").trim();
    const kind = el.matches("textarea, [role=textbox], [contenteditable=true]") ? "textbox" : "button";
    return { name, kind, x: r.x, y: r.y, w: r.width, h: r.height, disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true") };
  }).filter((c) => c.name);
})()`;

const COMPOSER_JS = `(() => {
  const el = [...document.querySelectorAll("[role=textbox], textarea, [contenteditable=true]")].find((node) => {
    const r = node.getBoundingClientRect();
    return r.width > 200 && r.height > 0;
  });
  if (!el) return "";
  return (el.innerText || el.value || "");
})()`;

const VISIBLE_CONVERSATION_JS = `(() => {
  const hit = [...document.querySelectorAll("[data-response-annotation-conversation]")].find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  return hit ? hit.getAttribute("data-response-annotation-conversation") || "" : "";
})()`;

function clickThreadJs(sidebarThreadId: string): string {
  const selector = `[data-app-action-sidebar-thread-id=${JSON.stringify(sidebarThreadId)}]`;
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "missing";
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return "missing";
    el.click();
    return "clicked";
  })()`;
}

function clickJs(name: string): string {
  return `(() => {
    const want = ${JSON.stringify(name)};
    const hits = [...document.querySelectorAll("button, [role=button], [role=menuitem]")].filter((el) => {
      const r = el.getBoundingClientRect();
      const label = (el.getAttribute("aria-label") || el.innerText || "").replace(/\\s+/g, " ").trim();
      return label === want && r.width > 0 && r.height > 0 && !el.disabled && el.getAttribute("aria-disabled") !== "true";
    }).sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
    if (!hits[0]) return "missing";
    hits[0].click();
    return "clicked";
  })()`;
}

const PROJECT_CREATE_HOVER_JS = `(() => {
  const btn = document.querySelector("[data-app-action-sidebar-project-create]");
  const row = btn && btn.closest("[class~=\\"group/nav-section-title\\"]");
  if (!row) return null;
  const r = row.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

const PROJECT_CREATE_CLICK_JS = `(() => {
  const btn = document.querySelector("[data-app-action-sidebar-project-create]");
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || getComputedStyle(btn).pointerEvents === "none") return null;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatgptPortUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export function chatgptAppRunning(): boolean {
  const proc = Bun.spawnSync(["pgrep", "-x", "ChatGPT"], { stdout: "ignore", stderr: "ignore" });
  return proc.exitCode === 0;
}

export async function connectChatgptPage(): Promise<ChatgptPage> {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) })).json() as { type?: string; url?: string; webSocketDebuggerUrl?: string }[];
  const page = list.find((item) => item.type === "page" && item.url === "app://-/index.html");
  if (!page?.webSocketDebuggerUrl) throw new Error("CHATGPT_PAGE_MISSING");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    const waiter = msg.id ? pending.get(msg.id) : undefined;
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error("CHATGPT_PAGE_MISSING"));
    else waiter.resolve(msg.result);
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CHATGPT_PAGE_MISSING")), 2000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("CHATGPT_PAGE_MISSING")); };
  });
  const send = (method: string, params?: object) => {
    const id = ++seq;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evalJs = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    return result?.result?.value;
  };
  return {
    controls: async () => (await evalJs(CONTROLS_JS) ?? []) as ChatgptControl[],
    async pointer(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await sleep(350);
    },
    async move(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(250);
    },
    projectCreateHover: async () => (await evalJs(PROJECT_CREATE_HOVER_JS)) ?? null,
    projectCreateClick: async () => (await evalJs(PROJECT_CREATE_CLICK_JS)) ?? null,
    async clickName(name) {
      const ok = await evalJs(clickJs(name));
      if (ok !== "clicked") throw new Error("CHATGPT_CLICK_MISSING");
      await sleep(400);
    },
    async insertText(text) {
      await send("Input.insertText", { text });
      await sleep(150);
    },
    composerText: async () => String(await evalJs(COMPOSER_JS) ?? ""),
    visibleConversation: async () => String(await evalJs(VISIBLE_CONVERSATION_JS) ?? ""),
    async clickThread(sidebarThreadId) {
      const ok = await evalJs(clickThreadJs(sidebarThreadId));
      if (ok !== "clicked") throw new Error("CHATGPT_THREAD_MISSING");
      await sleep(400);
    },
    close() {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}

export function recentRolloutFiles(dir: string, since: number): string[] {
  const out: string[] = [];
  const walk = (path: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(path); } catch { return; }
    for (const name of names) {
      const full = join(path, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
      } else if (name.endsWith(".jsonl") && st.mtimeMs >= since) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

export function readRolloutFile(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export async function relaunchChatgptWithPort(): Promise<void> {
  Bun.spawnSync(["osascript", "-e", 'quit app "ChatGPT"']);
  const gone = Date.now() + 12_000;
  while (Date.now() < gone && chatgptAppRunning()) await sleep(300);
  Bun.spawnSync(["open", "-a", "ChatGPT", "--args", "--remote-debugging-port=9334", "--remote-debugging-address=127.0.0.1"]);
  const up = Date.now() + 20_000;
  while (Date.now() < up) {
    if (await chatgptPortUp()) return;
    await sleep(400);
  }
  throw new Error("CHATGPT_PORT_DOWN");
}
