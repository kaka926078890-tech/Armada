import { invoke } from "@tauri-apps/api/core";
import {
  afterOpenWorkspaceFeedback,
  boardUrl,
  cdpZombieCopy,
  copiedToast,
  defaultLandingMode,
  firstArmadaJoinUri,
  noShareIpCopy,
  parseDesktopBoardRequest,
  parsePastedJoin,
  selectShareCandidate,
  shareJoinUri,
  shouldOpenBoardAfterCreate,
  shouldShowCreate,
  type CdpStatus,
  type LandingMode,
  type LocalAttachView,
  type ShareCandidate,
} from "../../desktop-core/src/index.ts";

const errEl = () => document.querySelector<HTMLParagraphElement>("#err");
const uriEl = () => document.querySelector<HTMLInputElement>("#join-uri");
const toastEl = () => document.querySelector<HTMLParagraphElement>("#toast");
const boardEl = () => document.querySelector<HTMLIFrameElement>("#board");
const createBtn = () => document.querySelector<HTMLButtonElement>("#create");
const windowsHint = () => document.querySelector<HTMLElement>("#windows-hint");
const createPane = () => document.querySelector<HTMLElement>("#create-pane");
const joinPane = () => document.querySelector<HTMLElement>("#join-pane");
const modeCreate = () => document.querySelector<HTMLInputElement>("#mode-create");
const modeJoin = () => document.querySelector<HTMLInputElement>("#mode-join");
const modeCreateLabel = () => document.querySelector<HTMLElement>("#mode-create-label");

type CreateFleetResult = {
  decision: "reuse-owned" | "spawn" | "attach";
  token: string;
  shareCandidates: ShareCandidate[];
  ownedHubPid: number | null;
  webviewOrigin?: string;
  attach?: LocalAttachView | null;
};

type JoinFleetResult = {
  webviewOrigin: string;
  token: string;
  cursorHubUrl: string;
  joinSelf: boolean;
  attach?: LocalAttachView | null;
};

let lastShareUri = "";

function setErr(msg: string) {
  const el = errEl();
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

function setBusy(busy: boolean) {
  const create = createBtn();
  const join = document.querySelector<HTMLButtonElement>("#join");
  if (create) {
    create.disabled = busy;
    create.textContent = busy ? "正在创建…" : "创建舰队";
  }
  if (join) {
    join.disabled = busy;
    join.textContent = busy ? "正在加入…" : "加入舰队";
  }
}

function showToast(msg: string, kind: "ok" | "err" = "ok") {
  const el = toastEl();
  if (!el || !msg) return;
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("toast-err", kind === "err");
  window.setTimeout(() => {
    if (el.textContent === msg) el.hidden = true;
  }, 4000);
}

function fleetErrorMessage(raw: string): string {
  const blob = raw.toLowerCase();
  const codes: [string, string][] = [
    ["incomplete", "链接不完整"],
    ["invalid", "链接无效"],
    ["unreachable", "无法连接中台"],
    ["foreign-armada", "7380 上已有另一份 Armada（令牌不同）"],
    ["port-busy", "7380 被其他程序占用"],
    ["join-must-not-spawn", "加入不会在本机启动中台"],
    ["create-macos-only", "创建舰队仅支持 macOS，请使用加入舰队"],
    ["no-share-ip", noShareIpCopy()],
    ["not-authorized", "鉴权失败，未写入 Cursor 设置"],
    ["spawn-timeout", "中台启动超时"],
    ["hub-root-missing", "未找到 hub 源码"],
    ["bun-missing", "未找到 Bun"],
    ["token-missing", "缺少令牌"],
    ["zombie", cdpZombieCopy()],
    ["open-failed", cdpZombieCopy()],
    ["path-not-absolute", "请选择绝对路径的文件夹"],
    ["path-not-dir", "路径不是文件夹"],
    ["launcher-missing", "未找到 Cursor 启动器脚本"],
    ["cursor-missing", "找不到 Cursor"],
    ["cancelled", "已取消"],
  ];
  for (const [code, msg] of codes) {
    if (blob.includes(code)) return msg;
  }
  return "操作失败";
}

function detectPlatform(): string {
  const plat = (navigator.platform || "").toLowerCase();
  if (plat.startsWith("mac")) return "macos";
  if (plat.startsWith("win")) return "windows";
  if (plat.includes("linux")) return "linux";
  return platformFromUa(navigator.userAgent);
}

function platformFromUa(ua: string): string {
  const s = ua.toLowerCase();
  if (s.includes("macintosh") || s.includes("mac os")) return "macos";
  if (s.includes("windows")) return "windows";
  if (s.includes("linux")) return "linux";
  return "unknown";
}

function applyLandingMode(mode: LandingMode) {
  const create = modeCreate();
  const join = modeJoin();
  if (create) create.checked = mode === "create";
  if (join) join.checked = mode === "join";
  const cPane = createPane();
  const jPane = joinPane();
  if (cPane) cPane.hidden = mode !== "create";
  if (jPane) jPane.hidden = mode !== "join";
}

function toastAttach(attach: LocalAttachView | null | undefined) {
  if (!attach) return;
  if (attach.settings === "ok") showToast("若 Cursor 已打开，请 Reload Window");
  if (attach.vsix === "manual-path-shown" && attach.vsixPath) {
    showToast(`请手工安装扩展：${attach.vsixPath}`, "err");
  }
  if (attach.hooks === "failed" || attach.settings === "failed") {
    showToast("本机 Cursor 接入未完成", "err");
  }
}

function openBoard(origin: string, token: string) {
  const url = boardUrl(origin, token);
  const frame = boardEl();
  if (frame) {
    frame.hidden = false;
    frame.src = url;
    document.body.classList.add("board-open");
    return;
  }
  window.location.assign(url);
}

function leaveBoard() {
  const frame = boardEl();
  if (frame) {
    frame.hidden = true;
    frame.removeAttribute("src");
    frame.src = "about:blank";
  }
  document.body.classList.remove("board-open");
  setErr("");
  setBusy(false);
  void invoke("quit_owned_hub").catch(() => {
    /* attach mode has no owned child */
  });
}

function rememberShareFromCreate(candidates: ShareCandidate[], token: string) {
  const selected = selectShareCandidate(candidates);
  lastShareUri = selected ? shareJoinUri(selected.ipv4, token) : "";
}

async function copyShare() {
  if (!lastShareUri) {
    showToast("暂无分享链接", "err");
    return;
  }
  try {
    await navigator.clipboard.writeText(lastShareUri);
    showToast(copiedToast());
  } catch {
    showToast("复制失败，请重试", "err");
  }
}

function joinFromPaste(raw: string) {
  const parsed = parsePastedJoin(raw);
  if ("error" in parsed) {
    setErr(parsed.error === "incomplete" ? "链接不完整" : "链接无效");
    return;
  }
  setErr("");
  lastShareUri = parsed.uri;
  setBusy(true);
  void invoke<JoinFleetResult>("join_fleet", { uri: parsed.uri })
    .then((r) => {
      toastAttach(r.attach);
      openBoard(r.webviewOrigin, r.token);
    })
    .catch((e) => setErr(fleetErrorMessage(String(e))))
    .finally(() => setBusy(false));
}

function wireDeepLink() {
  void import("@tauri-apps/plugin-deep-link")
    .then(async (mod) => {
      const apply = (urls: string[]) => {
        const raw = firstArmadaJoinUri(urls);
        if (!raw) return;
        applyLandingMode("join");
        const input = uriEl();
        if (input) input.value = raw;
        joinFromPaste(raw);
      };
      const current = await mod.getCurrent();
      if (current?.length) apply(current);
      await mod.onOpenUrl(apply);
    })
    .catch(() => {
      /* paste remains the v1 path */
    });
}

window.addEventListener("DOMContentLoaded", () => {
  const platform = detectPlatform();
  const canCreate = shouldShowCreate(platform);
  if (!canCreate) {
    const btn = createBtn();
    if (btn) btn.hidden = true;
    const hint = windowsHint();
    if (hint) hint.hidden = false;
    const label = modeCreateLabel();
    if (label) label.hidden = true;
    const radio = modeCreate();
    if (radio) radio.disabled = true;
    document.querySelector("#mode-field")?.classList.add("single");
  }

  applyLandingMode(defaultLandingMode(platform));

  modeCreate()?.addEventListener("change", () => applyLandingMode("create"));
  modeJoin()?.addEventListener("change", () => applyLandingMode("join"));

  document.querySelector("#create")?.addEventListener("click", () => {
    setErr("");
    setBusy(true);
    void invoke<CreateFleetResult>("create_fleet")
      .then((r) => {
        rememberShareFromCreate(r.shareCandidates, r.token);
        toastAttach(r.attach);
        if (!shouldOpenBoardAfterCreate(r.shareCandidates)) {
          setErr(noShareIpCopy());
          return;
        }
        openBoard(r.webviewOrigin ?? "127.0.0.1:7380", r.token);
      })
      .catch((e) => setErr(fleetErrorMessage(String(e))))
      .finally(() => setBusy(false));
  });

  document.querySelector("#join-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    joinFromPaste(uriEl()?.value ?? "");
  });

  window.addEventListener("message", (e) => {
    const frame = boardEl();
    if (!frame || e.source !== frame.contentWindow) return;
    const req = parseDesktopBoardRequest(e.data);
    if (!req) return;
    if (req === "get-share-link") {
      void copyShare();
      return;
    }
    if (req === "leave-fleet") {
      leaveBoard();
      return;
    }
    void openWorkspaceFromBoard();
  });

  wireDeepLink();
});

const WATCHDOG_MS = 10_000;
let openWsWatchdog: ReturnType<typeof setTimeout> | null = null;
let openWsZombiePoll: ReturnType<typeof setInterval> | null = null;

function clearOpenWorkspaceTimers() {
  if (openWsWatchdog !== null) {
    window.clearTimeout(openWsWatchdog);
    openWsWatchdog = null;
  }
  if (openWsZombiePoll !== null) {
    window.clearInterval(openWsZombiePoll);
    openWsZombiePoll = null;
  }
}

async function openWorkspaceFromBoard() {
  let absPath: string;
  try {
    absPath = await invoke<string>("pick_workspace");
  } catch (e) {
    const msg = String(e);
    if (msg.toLowerCase().includes("cancelled")) return;
    showToast(fleetErrorMessage(msg), "err");
    return;
  }
  absPath = absPath.trim();
  if (!absPath) return;
  setErr("");
  clearOpenWorkspaceTimers();
  try {
    await invoke("open_workspace", { absPath });
    openWsWatchdog = window.setTimeout(() => {
      openWsWatchdog = null;
      void invoke<CdpStatus>("cdp_status").then((s) => {
        const action = afterOpenWorkspaceFeedback("watchdog", s);
        if (action && action !== "clear" && action !== "continue") showToast(action, "err");
      });
    }, WATCHDOG_MS);
  } catch (e) {
    const raw = String(e);
    showToast(fleetErrorMessage(raw), "err");
    if (raw.toLowerCase().includes("zombie")) {
      openWsZombiePoll = window.setInterval(() => {
        void invoke<CdpStatus>("cdp_status").then((s) => {
          const action = afterOpenWorkspaceFeedback("zombie-poll", s);
          if (action === "continue") return;
          if (openWsZombiePoll !== null) {
            window.clearInterval(openWsZombiePoll);
            openWsZombiePoll = null;
          }
        });
      }, 1000);
    }
  }
}
