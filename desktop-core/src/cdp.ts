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

/** 启动器刚拉起、9222 还没听上：不要催退出，否则会和更新器抢单实例。 */
export function cdpStartingCopy(): string {
  return "Cursor 正在启动调试口，请稍候，不要再点打开工作区或图标。";
}

/** 多次探测仍是 absent：启动失败，仍禁止「马上再开一次」挤掉残进程。 */
export function cdpStartTimeoutCopy(): string {
  return "Cursor 没有带调试口起来。请确认已完全退出后，只再打开一次工作区，不要点 Cursor 图标。";
}

export type AfterOpenWorkspaceZombiePoll = "continue" | "clear" | "stop";

export type AfterZombieCleared = "wait" | "launch" | "ready";

/** 1s 一轮；连续 absent 满 3s 再跑启动器，避开更新器立刻无参重开。 */
export const ZOMBIE_ABSENT_TICKS_BEFORE_LAUNCH = 3;

export type ZombiePollState = { action: AfterZombieCleared; absentTicks: number };

export type WatchdogOutcome = { toast: string; retry: boolean };

export type ExclusiveGate = { claimed: boolean };

export type ZombiePollGate = ExclusiveGate & { absentTicks: number };

/** Board 连点 / 重叠 poll 只允许一次打开工作区。 */
export function tryClaimExclusive(gate: ExclusiveGate): boolean {
  if (gate.claimed) return false;
  gate.claimed = true;
  return true;
}

export function tickZombiePoll(status: CdpStatus, absentTicks: number): ZombiePollState {
  if (status === "zombie") return { action: "wait", absentTicks: 0 };
  if (status === "ready") return { action: "ready", absentTicks: 0 };
  const n = absentTicks + 1;
  if (n >= ZOMBIE_ABSENT_TICKS_BEFORE_LAUNCH) return { action: "launch", absentTicks: n };
  return { action: "wait", absentTicks: n };
}

/** zombie 修好：等用户退出。第一拍 absent 仍 wait，避免和更新器抢锁。 */
export function afterZombieCleared(status: CdpStatus, absentTicks = 0): AfterZombieCleared {
  return tickZombiePoll(status, absentTicks).action;
}

/**
 * 刚拉起时进程在、9222 未听上也算 starting：立刻催退出会让人再开一次，和残实例互杀。
 * retries 用尽后 zombie 才是吞口，absent 才是启动失败。
 */
export function watchdogOutcome(status: CdpStatus, absentRetriesLeft: number): WatchdogOutcome {
  if (status === "ready") return { toast: "", retry: false };
  if (absentRetriesLeft > 0) return { toast: cdpStartingCopy(), retry: true };
  if (status === "zombie") return { toast: cdpWatchdogCopy(), retry: false };
  return { toast: cdpStartTimeoutCopy(), retry: false };
}

/** 重叠的 1s tick 共用 gate：第一次 launch/ready 之后不再二次启动。 */
export function advanceZombiePoll(gate: ZombiePollGate, status: CdpStatus): ZombiePollState {
  if (gate.claimed) return { action: "wait", absentTicks: gate.absentTicks };
  const next = tickZombiePoll(status, gate.absentTicks);
  gate.absentTicks = next.absentTicks;
  if (next.action === "launch" || next.action === "ready") {
    gate.claimed = true;
  }
  return next;
}

/**
 * User-facing error after open_workspace:
 * - watchdog: 10s after success；ready 清空；retries 内 zombie/absent 都算启动中。
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
    return watchdogOutcome(status, 1).toast;
  }
  if (status === "zombie") return "continue";
  if (status === "absent") return "clear";
  return "stop";
}
