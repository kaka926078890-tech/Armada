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

export type DesktopBoardRequest = "open-workspace" | "get-share-link" | "leave-fleet";

export type LandingMode = "create" | "join";

export function boardUrl(webviewOrigin: string, token: string): string {
  return `http://${webviewOrigin}/?token=${token}&desktop=1`;
}

export function defaultLandingMode(platform: string): LandingMode {
  return shouldShowCreate(platform) ? "create" : "join";
}

export function parseDesktopBoardRequest(data: unknown): DesktopBoardRequest | null {
  if (!data || typeof data !== "object") return null;
  const o = data as { source?: unknown; type?: unknown };
  if (o.source !== DESKTOP_BOARD_SOURCE) return null;
  if (o.type === "open-workspace" || o.type === "get-share-link" || o.type === "leave-fleet") return o.type;
  return null;
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

export function firstArmadaJoinUri(urls: string[]): string | null {
  for (const u of urls) {
    const t = u.trim();
    if (t.startsWith("armada:")) return t;
  }
  return null;
}

export function parsePastedJoin(raw: string): { uri: string } | { error: "incomplete" | "invalid" } {
  const trimmed = raw.trim();
  const r = parseJoinUri(trimmed);
  if ("error" in r) return { error: r.error };
  return { uri: trimmed };
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
