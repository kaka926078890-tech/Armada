import { cdpZombieCopy } from "./cdp";
import { formatJoinUri, parseJoinUri } from "./joinUri";

export type ShareCandidate = { ipv4: string; name: string; maybeUnreachable: boolean };

export type LocalAttachView = {
  vsix: "ok" | "skipped-same-version" | "manual-path-shown";
  hooks: "ok" | "failed";
  settings: "ok" | "failed";
  hubUrlWritten: string;
  vsixPath?: string;
};

export type AttachBanner = { kind: "red" | "info" | "none"; lines: string[] };

export const DESKTOP_BOARD_SOURCE = "armada-desktop";

export type DesktopBoardCommand = "open-workspace" | "repair-cdp" | "get-share-link" | "leave-fleet" | "need-token";

export type DesktopRunAlert = {
  type: "run.alert";
  runId: string;
  machineId: string;
  workspaceRoot: string;
  title: string;
  body: string;
};

export type DesktopBoardRequest =
  | { type: DesktopBoardCommand }
  | DesktopRunAlert;

export type LandingMode = "create" | "join";

export function boardUrl(webviewOrigin: string, token: string): string {
  return `http://${webviewOrigin}/?token=${token}&desktop=1`;
}

/** iframe `MessageEvent.origin` for a hub host:port stored by openBoard. */
export function boardFrameOrigin(webviewOrigin: string): string {
  try {
    return new URL(`http://${webviewOrigin}`).origin;
  } catch {
    return "";
  }
}

export function isTrustedBoardMessageOrigin(eventOrigin: string, currentBoardOrigin: string | null): boolean {
  return !!currentBoardOrigin && eventOrigin === currentBoardOrigin;
}

export type BoardSession = { origin: string; token: string };

export function serializeBoardSession(session: BoardSession): string {
  return JSON.stringify({ origin: session.origin, token: session.token });
}

export function parseBoardSession(raw: string | null): BoardSession | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.origin !== "string" || !o.origin.trim()) return null;
    if (typeof o.token !== "string" || !o.token) return null;
    return { origin: o.origin.trim(), token: o.token };
  } catch {
    return null;
  }
}

export const BOARD_REOPEN_COOLDOWN_MS = 8000;
export const BOARD_REOPEN_MAX = 2;

export type BoardReopenDecision = "reopen" | "wait" | "give-up";

export function decideBoardReopen(opts: {
  reopenCount: number;
  lastAt: number | null;
  now: number;
  cooldownMs?: number;
  maxReopens?: number;
}): BoardReopenDecision {
  const max = opts.maxReopens ?? BOARD_REOPEN_MAX;
  const cooldown = opts.cooldownMs ?? BOARD_REOPEN_COOLDOWN_MS;
  if (opts.reopenCount >= max) return "give-up";
  if (opts.lastAt != null && opts.now - opts.lastAt < cooldown) return "wait";
  return "reopen";
}

export type NeedTokenAction = "reopen" | "wait" | "restore-hub" | "recreate";

export function decideNeedToken(opts: {
  hasSession: boolean;
  reopenCount: number;
  lastAt: number | null;
  now: number;
}): NeedTokenAction {
  if (!opts.hasSession) return "recreate";
  const d = decideBoardReopen(opts);
  if (d === "give-up") return "restore-hub";
  return d;
}

export function recreateFleetCopy(): string {
  return "鉴权失败，请重新创建或加入舰队";
}

export function restoreHubCopy(): string {
  return "中台进程已退出，正在恢复";
}

export function isLocalOwnedBoard(origin: string): boolean {
  const host = origin.split("/")[0].toLowerCase();
  return host.startsWith("127.0.0.1:") || host.startsWith("localhost:");
}

export function defaultLandingMode(platform: string): LandingMode {
  return shouldShowCreate(platform) ? "create" : "join";
}

export function parseDesktopBoardRequest(data: unknown): DesktopBoardRequest | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.source !== DESKTOP_BOARD_SOURCE) return null;
  if (o.type === "open-workspace" || o.type === "repair-cdp" || o.type === "get-share-link" || o.type === "leave-fleet" || o.type === "need-token") {
    return { type: o.type };
  }
  if (o.type !== "run.alert") return null;
  if (
    typeof o.runId !== "string" || !o.runId
    || typeof o.machineId !== "string" || !o.machineId
    || typeof o.workspaceRoot !== "string" || !o.workspaceRoot
    || typeof o.title !== "string" || !o.title
    || typeof o.body !== "string"
  ) return null;
  return {
    type: "run.alert",
    runId: o.runId,
    machineId: o.machineId,
    workspaceRoot: o.workspaceRoot,
    title: o.title,
    body: o.body,
  };
}

export function shouldShowCreate(platform: string): boolean {
  return platform !== "windows";
}

export function shouldOpenBoardAfterCreate(candidates: ShareCandidate[]): boolean {
  return candidates.length > 0;
}

export function noShareIpCopy(): string {
  return "未检测到局域网地址。请连接到局域网，或手工填写分享地址（不会自动复制到剪贴板）。";
}

export function selectShareCandidate(candidates: ShareCandidate[]): ShareCandidate | null {
  return candidates[0] ?? null;
}

export function shareJoinUri(ipv4: string, token: string): string {
  return formatJoinUri(`${ipv4}:7380`, token);
}

export function copiedToast(): string {
  return "已复制分享链接";
}

export function canStartJoin(inFlight: boolean): boolean {
  return !inFlight;
}

export function joinButtonLabel(busy: boolean): string {
  return busy ? "正在加入…" : "加入舰队";
}

export function firstArmadaJoinUri(urls: string[]): string | null {
  for (const u of urls) {
    const t = u.trim();
    if (!t.startsWith("armada:")) continue;
    const parsed = parseJoinUri(t);
    if (!("error" in parsed) || parsed.error === "incomplete") return t;
  }
  return null;
}

export function parsePastedJoin(raw: string): { uri: string } | { error: "incomplete" | "invalid" } {
  const trimmed = raw.trim();
  const r = parseJoinUri(trimmed);
  if ("error" in r) return { error: r.error };
  return { uri: trimmed };
}

export function fleetErrorCopy(raw: string): string {
  const blob = raw.trim().toLowerCase();
  const codes: [string, string][] = [
    ["unauthorized", "加入票据无效或已过期，请让中台重新打开可发现"],
    ["incomplete", "链接不完整"],
    ["invalid", "链接无效"],
    ["unreachable", "无法连接中台"],
    ["foreign-armada", "7380 上已有另一份 Armada（令牌不同）"],
    ["port-busy", "7380 被其他程序占用"],
    ["join-must-not-spawn", "加入不会在本机启动中台"],
    ["join-in-flight", "正在加入，请稍候"],
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
  const byCode = new Map(codes);
  const exact = byCode.get(blob);
  if (exact) return exact;
  const colon = blob.match(/:\s*([a-z0-9-]+)\s*$/);
  if (colon) {
    const mapped = byCode.get(colon[1]!);
    if (mapped) return mapped;
  }
  return "操作失败";
}

export function attachBanner(attach: LocalAttachView | null | undefined): AttachBanner {
  if (!attach) {
    return { kind: "red", lines: ["本机 Cursor 未接入"] };
  }
  const lines: string[] = [];
  let red = false;
  if (attach.hooks === "failed") {
    red = true;
    lines.push("hooks 安装失败");
  }
  if (attach.settings === "failed") {
    red = true;
    lines.push("Cursor settings 写入失败");
  }
  if (attach.vsix === "manual-path-shown" && attach.vsixPath) {
    lines.push(`请手工安装扩展：${attach.vsixPath}`);
  }
  if (attach.settings === "ok") {
    lines.push("若 Cursor 已打开，请 Reload Window");
  }
  if (red) return { kind: "red", lines };
  if (lines.length) return { kind: "info", lines };
  return { kind: "none", lines: [] };
}
