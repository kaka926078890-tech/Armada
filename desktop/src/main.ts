import { invoke } from "@tauri-apps/api/core";
import {
  afterOpenWorkspaceFeedback,
  afterZombieCleared,
  advertiseFailedCopy,
  boardUrl,
  copiedToast,
  decideNeedToken,
  defaultDiscoverable,
  defaultLandingMode,
  discoveredRowView,
  canStartJoin,
  firstArmadaJoinUri,
  firstArmadaOpenRun,
  joinButtonLabel,
  formatOpenRunUri,
  noOpenFleetsCopy,
  noShareIpCopy,
  parseBoardSession,
  parseDesktopBoardRequest,
  boardFrameOrigin,
  isTrustedBoardMessageOrigin,
  parsePastedJoin,
  fleetErrorCopy,
  recreateFleetCopy,
  restoreDecisionNotice,
  restoreHubCopy,
  isLocalOwnedBoard,
  selectShareCandidate,
  serializeBoardSession,
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
  advertised?: boolean;
  advertiseError?: string | null;
};

type JoinFleetResult = {
  webviewOrigin: string;
  token: string;
  cursorHubUrl: string;
  joinSelf: boolean;
  attach?: LocalAttachView | null;
};

let lastShareUri = "";
let joinInFlight = false;
const BOARD_SESSION_KEY = "armada.boardSession";
let lastBoard = parseBoardSession(
  typeof localStorage === "undefined" ? null : localStorage.getItem(BOARD_SESSION_KEY),
);
let currentBoardOrigin: string | null = null;
let reopenCount = 0;
let lastReopenAt: number | null = null;

type FoundFleet = { id: string; name: string; ipv4: string; port: number; joinUri: string };
const discovered = new Map<string, FoundFleet>();
const DISCOVERED_CAP = 32;

function discoveredEmptyEl() {
  return document.querySelector<HTMLParagraphElement>("#discovered-empty");
}
function discoveredListEl() {
  return document.querySelector<HTMLElement>("#discovered-list");
}

function renderDiscovered() {
  const list = discoveredListEl();
  const empty = discoveredEmptyEl();
  if (!list || !empty) return;
  const rows = [...discovered.values()].slice(0, DISCOVERED_CAP);
  empty.textContent = noOpenFleetsCopy();
  empty.hidden = rows.length > 0;
  list.replaceChildren();
  for (const row of rows) {
    const view = discoveredRowView({ name: row.name, ipv4: row.ipv4, port: row.port });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fleet-row";
    btn.dataset.id = row.id;
    const title = document.createElement("span");
    title.className = "fleet-title";
    title.textContent = view.title;
    const sub = document.createElement("span");
    sub.className = "fleet-sub";
    sub.textContent = view.subtitle;
    btn.append(title, sub);
    btn.disabled = !canStartJoin(joinInFlight);
    btn.addEventListener("click", () => {
      if (!canStartJoin(joinInFlight)) return;
      const found = discovered.get(row.id);
      if (found) joinFromPaste(found.joinUri);
    });
    list.append(btn);
  }
}

function startJoinBrowse() {
  discovered.clear();
  renderDiscovered();
  void invoke("start_fleet_browse").catch(() => {
    renderDiscovered();
  });
}

function stopJoinBrowse() {
  void invoke("stop_fleet_browse").catch(() => {
    /* web preview without tauri */
  });
}

function wireDiscovery() {
  void import("@tauri-apps/api/event")
    .then(({ listen }) => {
      void listen<FoundFleet>("fleet-found", (ev) => {
        const row = ev.payload;
        if (!row?.id || !row.joinUri) return;
        if (discovered.size >= DISCOVERED_CAP && !discovered.has(row.id)) return;
        discovered.set(row.id, row);
        renderDiscovered();
      });
      void listen<{ id: string }>("fleet-lost", (ev) => {
        if (!ev.payload?.id) return;
        discovered.delete(ev.payload.id);
        renderDiscovered();
      });
    })
    .catch(() => {
      /* web preview without tauri */
    });
}

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
    join.textContent = joinButtonLabel(busy);
  }
  const input = uriEl();
  if (input) input.disabled = busy;
  renderDiscovered();
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
  return fleetErrorCopy(raw);
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
  if (mode === "join") startJoinBrowse();
  else stopJoinBrowse();
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

function persistBoard(origin: string, token: string) {
  lastBoard = { origin, token };
  try { localStorage.setItem(BOARD_SESSION_KEY, serializeBoardSession(lastBoard)); } catch { /* quota / private */ }
}

function clearBoardSession() {
  lastBoard = null;
  reopenCount = 0;
  lastReopenAt = null;
  try { localStorage.removeItem(BOARD_SESSION_KEY); } catch { /* ignore */ }
}

function openBoard(origin: string, token: string, fromNeedToken = false) {
  persistBoard(origin, token);
  currentBoardOrigin = boardFrameOrigin(origin);
  if (!fromNeedToken) {
    reopenCount = 0;
    lastReopenAt = null;
  }
  stopJoinBrowse();
  const url = fromNeedToken ? `${boardUrl(origin, token)}&_=${Date.now()}` : boardUrl(origin, token);
  const frame = boardEl();
  if (frame) {
    frame.hidden = false;
    frame.src = url;
    document.body.classList.add("board-open");
    frame.addEventListener("load", () => flushPendingOpen(frame), { once: true });
    return;
  }
  window.location.assign(url);
}

function onNeedToken() {
  if (!lastBoard && typeof localStorage !== "undefined") {
    lastBoard = parseBoardSession(localStorage.getItem(BOARD_SESSION_KEY));
  }
  const decision = decideNeedToken({
    hasSession: !!lastBoard,
    reopenCount,
    lastAt: lastReopenAt,
    now: Date.now(),
  });
  if (decision === "recreate") {
    showToast(recreateFleetCopy(), "err");
    return;
  }
  if (decision === "wait") return;
  if (decision === "restore-hub") {
    if (lastBoard && !isLocalOwnedBoard(lastBoard.origin)) {
      reopenCount = 0;
      lastReopenAt = Date.now();
      openBoard(lastBoard.origin, lastBoard.token, true);
      return;
    }
    void restoreOwnedHub({ toast: true });
    return;
  }
  if (!lastBoard) return;
  reopenCount += 1;
  lastReopenAt = Date.now();
  openBoard(lastBoard.origin, lastBoard.token, true);
}

let restoringHub = false;

async function restoreOwnedHub(opts?: { toast?: boolean }) {
  if (restoringHub) return;
  restoringHub = true;
  if (opts?.toast) showToast(restoreHubCopy());
  try {
    const r = await invoke<CreateFleetResult>("ensure_owned_hub");
    reopenCount = 0;
    lastReopenAt = Date.now();
    rememberShareFromCreate(r.shareCandidates, r.token);
    const attachNotice = restoreDecisionNotice(r.decision);
    if (attachNotice) showToast(attachNotice);
    toastAttach(r.attach);
    openBoard(r.webviewOrigin ?? "127.0.0.1:7380", r.token);
  } catch (e) {
    showToast(fleetErrorMessage(String(e)), "err");
  } finally {
    restoringHub = false;
  }
}

function startHubWatchdog() {
  window.setInterval(() => {
    if (!lastBoard) return;
    if (!document.body.classList.contains("board-open")) return;
    if (!isLocalOwnedBoard(lastBoard.origin)) return;
    void invoke<CreateFleetResult>("ensure_owned_hub")
      .then((r) => {
        if (r.decision === "spawn") {
          reopenCount = 0;
          openBoard(r.webviewOrigin ?? "127.0.0.1:7380", r.token);
        }
      })
      .catch(() => { /* next tick */ });
  }, 10_000);
}

type OpenRunPayload = { runId: string; machineId: string; workspaceRoot: string };
let pendingOpenRun: OpenRunPayload | null = null;

function postOpenRun(frame: HTMLIFrameElement, payload: OpenRunPayload): boolean {
  if (!frame.contentWindow || !currentBoardOrigin) return false;
  frame.contentWindow.postMessage(
    { source: "armada-desktop-host", type: "open-run", ...payload },
    currentBoardOrigin,
  );
  return true;
}

function flushPendingOpen(frame: HTMLIFrameElement) {
  if (!pendingOpenRun) return;
  if (postOpenRun(frame, pendingOpenRun)) pendingOpenRun = null;
}

function handleOpenRun(payload: OpenRunPayload) {
  const frame = boardEl();
  if (!frame || frame.hidden || !postOpenRun(frame, payload)) {
    pendingOpenRun = payload;
  }
}

function wireRunAlertClick() {
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<OpenRunPayload>("run-alert-clicked", (ev) => {
      handleOpenRun(ev.payload);
    }))
    .catch(() => {
      /* web preview without tauri */
    });
}

function leaveBoard() {
  clearBoardSession();
  currentBoardOrigin = null;
  const frame = boardEl();
  if (frame) {
    frame.hidden = true;
    frame.removeAttribute("src");
    frame.src = "about:blank";
  }
  document.body.classList.remove("board-open");
  setErr("");
  setBusy(false);
  const mode: LandingMode = modeJoin()?.checked ? "join" : "create";
  void invoke("quit_owned_hub")
    .catch(() => {
      /* attach mode has no owned child */
    })
    .finally(() => applyLandingMode(mode));
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
  if (!canStartJoin(joinInFlight)) return;
  const parsed = parsePastedJoin(raw);
  if ("error" in parsed) {
    setErr(parsed.error === "incomplete" ? "链接不完整" : "链接无效");
    return;
  }
  joinInFlight = true;
  setErr("");
  lastShareUri = parsed.uri;
  setBusy(true);
  void invoke<JoinFleetResult>("join_fleet", { uri: parsed.uri })
    .then((r) => {
      toastAttach(r.attach);
      openBoard(r.webviewOrigin, r.token);
    })
    .catch((e) => setErr(fleetErrorMessage(String(e))))
    .finally(() => {
      joinInFlight = false;
      setBusy(false);
    });
}

function wireDeepLink() {
  void import("@tauri-apps/plugin-deep-link")
    .then(async (mod) => {
      const apply = (urls: string[]) => {
        const open = firstArmadaOpenRun(urls);
        if (open) {
          handleOpenRun(open);
          return;
        }
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

  if (canCreate && (!lastBoard || isLocalOwnedBoard(lastBoard.origin))) {
    void restoreOwnedHub();
  } else if (lastBoard) {
    openBoard(lastBoard.origin, lastBoard.token);
  }
  startHubWatchdog();

  document.querySelector("#create")?.addEventListener("click", () => {
    setErr("");
    setBusy(true);
    void invoke<CreateFleetResult>("create_fleet", {
      discoverable: document.querySelector<HTMLInputElement>("#discoverable")?.checked ?? defaultDiscoverable(),
    })
      .then((r) => {
        rememberShareFromCreate(r.shareCandidates, r.token);
        toastAttach(r.attach);
        const wanted = document.querySelector<HTMLInputElement>("#discoverable")?.checked ?? defaultDiscoverable();
        if (wanted && !r.advertised) showToast(advertiseFailedCopy(), "err");
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
    if (!isTrustedBoardMessageOrigin(e.origin, currentBoardOrigin)) return;
    const req = parseDesktopBoardRequest(e.data);
    if (!req) return;
    if (req.type === "get-share-link") {
      void copyShare();
      return;
    }
    if (req.type === "leave-fleet") {
      leaveBoard();
      return;
    }
    if (req.type === "need-token") {
      onNeedToken();
      return;
    }
    if (req.type === "open-workspace" || req.type === "repair-cdp") {
      void openWorkspaceFromBoard();
      return;
    }
    if (req.type === "run.alert") {
      void invoke("show_run_alert", {
        runId: req.runId,
        machineId: req.machineId,
        workspaceRoot: req.workspaceRoot,
        title: req.title,
        body: req.body,
        launchUri: formatOpenRunUri({
          runId: req.runId,
          machineId: req.machineId,
          workspaceRoot: req.workspaceRoot,
        }),
      }).catch((err) => console.error("show_run_alert", err));
      return;
    }
  });

  wireDeepLink();
  wireRunAlertClick();
  wireDiscovery();
});

const WATCHDOG_MS = 10_000;
let openWsWatchdog: number | null = null;
let openWsZombiePoll: number | null = null;

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
          const next = afterZombieCleared(s);
          if (next === "wait") return;
          if (openWsZombiePoll !== null) {
            window.clearInterval(openWsZombiePoll);
            openWsZombiePoll = null;
          }
          if (next === "launch") {
            void invoke("open_workspace", { absPath }).catch((err) => {
              showToast(fleetErrorMessage(String(err)), "err");
            });
          }
        });
      }, 1000);
    }
  }
}
