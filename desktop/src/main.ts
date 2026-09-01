import { invoke } from "@tauri-apps/api/core";
import {
  attachBanner,
  boardUrl,
  copiedToast,
  firstArmadaJoinUri,
  parsePastedJoin,
  selectShareCandidate,
  shareJoinUri,
  shouldShowCreate,
  type LocalAttachView,
  type ShareCandidate,
} from "../../desktop-core/src/index.ts";

const errEl = () => document.querySelector<HTMLPreElement>("#err");
const uriEl = () => document.querySelector<HTMLInputElement>("#join-uri");
const shareEl = () => document.querySelector<HTMLElement>("#share");
const shareUriEl = () => document.querySelector<HTMLInputElement>("#share-uri");
const candidatesEl = () => document.querySelector<HTMLUListElement>("#share-candidates");
const toastEl = () => document.querySelector<HTMLParagraphElement>("#copy-toast");
const attachEl = () => document.querySelector<HTMLDivElement>("#attach-bar");
const boardEl = () => document.querySelector<HTMLIFrameElement>("#board");
const createBtn = () => document.querySelector<HTMLButtonElement>("#create");
const windowsHint = () => document.querySelector<HTMLElement>("#windows-hint");

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

function setErr(msg: string) {
  const el = errEl();
  if (el) el.textContent = msg;
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
    ["not-authorized", "鉴权失败，未写入 Cursor 设置"],
    ["spawn-timeout", "中台启动超时"],
    ["hub-root-missing", "未找到 hub 源码"],
    ["bun-missing", "未找到 Bun"],
    ["token-missing", "缺少令牌"],
  ];
  for (const [code, msg] of codes) {
    if (blob.includes(code)) return msg;
  }
  return "操作失败";
}

function platformFromUa(ua: string): string {
  const s = ua.toLowerCase();
  if (s.includes("windows")) return "windows";
  if (s.includes("mac")) return "macos";
  if (s.includes("linux")) return "linux";
  return "unknown";
}

function showAttach(attach: LocalAttachView | null | undefined) {
  const el = attachEl();
  if (!el) return;
  const banner = attachBanner(attach);
  if (banner.kind === "none") {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("attach-red", "attach-info");
    return;
  }
  el.hidden = false;
  el.textContent = banner.lines.join("\n");
  el.classList.toggle("attach-red", banner.kind === "red");
  el.classList.toggle("attach-info", banner.kind === "info");
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

function renderShare(candidates: ShareCandidate[], token: string) {
  const section = shareEl();
  const input = shareUriEl();
  const list = candidatesEl();
  if (!section || !input || !list) return;
  const selected = selectShareCandidate(candidates);
  if (!selected) {
    input.value = "";
    list.replaceChildren();
    section.hidden = false;
    const empty = document.createElement("li");
    empty.textContent = "无局域网分享地址";
    list.append(empty);
    return;
  }
  input.value = shareJoinUri(selected.ipv4, token);
  list.replaceChildren();
  for (const c of candidates) {
    const li = document.createElement("li");
    const mark = c.maybeUnreachable ? " （可能无法访问）" : "";
    li.textContent = `${c.name} ${c.ipv4}${mark}`;
    if (c.ipv4 === selected.ipv4) li.classList.add("selected");
    list.append(li);
  }
  section.hidden = false;
}

async function copyShare() {
  const input = shareUriEl();
  const toast = toastEl();
  const uri = input?.value ?? "";
  if (!uri) return;
  try {
    await navigator.clipboard.writeText(uri);
  } catch {
    input?.select();
    document.execCommand("copy");
  }
  if (toast) {
    toast.hidden = false;
    toast.textContent = copiedToast();
  }
}

function joinFromPaste(raw: string) {
  const parsed = parsePastedJoin(raw);
  if ("error" in parsed) {
    setErr(parsed.error === "incomplete" ? "链接不完整" : "链接无效");
    return;
  }
  setErr("");
  void invoke<JoinFleetResult>("join_fleet", { uri: parsed.uri })
    .then((r) => {
      showAttach(r.attach);
      openBoard(r.webviewOrigin, r.token);
    })
    .catch((e) => setErr(fleetErrorMessage(String(e))));
}

function wireDeepLink() {
  void import("@tauri-apps/plugin-deep-link")
    .then(async (mod) => {
      const apply = (urls: string[]) => {
        const raw = firstArmadaJoinUri(urls);
        if (!raw) return;
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
  const platform = platformFromUa(navigator.userAgent);
  if (!shouldShowCreate(platform)) {
    const btn = createBtn();
    if (btn) btn.hidden = true;
    const hint = windowsHint();
    if (hint) hint.hidden = false;
  }

  const input = uriEl();
  if (input) input.placeholder = shareJoinUri("192.168.1.23", "<token>");

  document.querySelector("#copy")?.addEventListener("click", () => {
    void copyShare();
  });

  document.querySelector("#create")?.addEventListener("click", () => {
    setErr("");
    void invoke<CreateFleetResult>("create_fleet")
      .then((r) => {
        renderShare(r.shareCandidates, r.token);
        showAttach(r.attach);
        openBoard(r.webviewOrigin ?? "127.0.0.1:7380", r.token);
      })
      .catch((e) => setErr(fleetErrorMessage(String(e))));
  });

  document.querySelector("#join")?.addEventListener("click", () => {
    joinFromPaste(uriEl()?.value ?? "");
  });
  document.querySelector("#join-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    joinFromPaste(uriEl()?.value ?? "");
  });

  wireDeepLink();
});
