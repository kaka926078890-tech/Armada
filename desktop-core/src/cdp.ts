export type CdpStatus = "ready" | "zombie" | "absent";

export function classifyCdp(cdpOk: boolean, cursorAlive: boolean): CdpStatus {
  if (cdpOk) return "ready";
  if (cursorAlive) return "zombie";
  return "absent";
}

export function shouldRunLauncher(status: CdpStatus): boolean {
  return status === "absent";
}

export function cdpStatusLabel(status: CdpStatus): string {
  switch (status) {
    case "ready":
      return "CDP 就绪";
    case "zombie":
      return "残实例（请先退出 Cursor）";
    case "absent":
      return "Cursor 未运行";
  }
}

/** Spec §5.3 残实例句：进程在、9222 不通时阻塞启动器。 */
export function cdpZombieCopy(): string {
  return "Cursor 正在运行但调试口 9222 不通。请先完全退出（Cmd+Q / 托盘 Exit），不要从图标再开第二个实例。";
}

/** Spec §5.3 看门狗：打开后 10s 再探仍不通。 */
export function cdpWatchdogCopy(): string {
  return "单实例吞掉了调试口。请先完全退出 Cursor（Cmd+Q / 托盘 Exit），再用本应用打开工作区。";
}

export type AfterOpenWorkspaceZombiePoll = "continue" | "clear" | "stop";

/**
 * User-facing error after open_workspace:
 * - watchdog: 10s after success; clear when ready, else watchdog copy.
 * - zombie-poll: catch-path 1s poll after invoke rejected as zombie.
 */
export function afterOpenWorkspaceFeedback(
  kind: "watchdog",
  status: CdpStatus,
): string;
export function afterOpenWorkspaceFeedback(
  kind: "zombie-poll",
  status: CdpStatus,
): AfterOpenWorkspaceZombiePoll;
export function afterOpenWorkspaceFeedback(
  kind: "watchdog" | "zombie-poll",
  status: CdpStatus,
): string | AfterOpenWorkspaceZombiePoll {
  if (kind === "watchdog") {
    return status === "ready" ? "" : cdpWatchdogCopy();
  }
  if (status === "zombie") return "continue";
  if (status === "absent") return "clear";
  return "stop";
}
