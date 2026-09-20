import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterOpenWorkspaceFeedback,
  afterZombieCleared,
  advanceZombiePoll,
  cdpStartingCopy,
  cdpStatusLabel,
  cdpWatchdogCopy,
  cdpZombieCopy,
  classifyCdp,
  shouldRunLauncher,
  tickZombiePoll,
  tryClaimExclusive,
  watchdogOutcome,
  ZOMBIE_ABSENT_TICKS_BEFORE_LAUNCH,
  type ZombiePollGate,
} from "../src/cdp";

describe("classifyCdp", () => {
  test("TCP success is ready regardless of process", () => {
    expect(classifyCdp(true, true)).toBe("ready");
    expect(classifyCdp(true, false)).toBe("ready");
  });

  test("process without CDP is zombie; neither is absent", () => {
    expect(classifyCdp(false, true)).toBe("zombie");
    expect(classifyCdp(false, false)).toBe("absent");
  });
});

describe("shouldRunLauncher", () => {
  test("never runs launcher when ready or zombie", () => {
    expect(shouldRunLauncher("ready")).toBe(false);
    expect(shouldRunLauncher("zombie")).toBe(false);
    expect(shouldRunLauncher("absent")).toBe(true);
  });
});

describe("afterOpenWorkspaceFeedback", () => {
  test("watchdog clears on ready; first probe treats process-without-port as still starting", () => {
    expect(afterOpenWorkspaceFeedback("watchdog", "ready")).toBe("");
    expect(afterOpenWorkspaceFeedback("watchdog", "zombie")).toBe(cdpStartingCopy());
    expect(afterOpenWorkspaceFeedback("watchdog", "absent")).toBe(cdpStartingCopy());
    expect(afterOpenWorkspaceFeedback("watchdog", "absent")).not.toBe(cdpWatchdogCopy());
  });

  test("zombie-poll continues until user quits or CDP recovers", () => {
    expect(afterOpenWorkspaceFeedback("zombie-poll", "zombie")).toBe("continue");
    expect(afterOpenWorkspaceFeedback("zombie-poll", "absent")).toBe("clear");
    expect(afterOpenWorkspaceFeedback("zombie-poll", "ready")).toBe("stop");
  });
});

describe("afterZombieCleared", () => {
  test("wait while zombie, do not launch on the first absent tick, stop when ready", () => {
    expect(afterZombieCleared("zombie")).toBe("wait");
    expect(afterZombieCleared("absent")).toBe("wait");
    expect(afterZombieCleared("ready")).toBe("ready");
  });
});

describe("tickZombiePoll", () => {
  test("debounces absent so updater relaunch is not raced", () => {
    expect(ZOMBIE_ABSENT_TICKS_BEFORE_LAUNCH).toBeGreaterThanOrEqual(3);
    let ticks = 0;
    const first = tickZombiePoll("absent", ticks);
    expect(first.action).toBe("wait");
    ticks = first.absentTicks;
    const second = tickZombiePoll("absent", ticks);
    expect(second.action).toBe("wait");
    ticks = second.absentTicks;
    const third = tickZombiePoll("absent", ticks);
    expect(third.action).toBe("launch");
  });

  test("updater relaunch during debounce resets to wait", () => {
    const afterOneAbsent = tickZombiePoll("absent", 0);
    expect(afterOneAbsent.action).toBe("wait");
    const updaterBack = tickZombiePoll("zombie", afterOneAbsent.absentTicks);
    expect(updaterBack).toEqual({ action: "wait", absentTicks: 0 });
  });
});

describe("watchdogOutcome", () => {
  test("absent reschedules instead of telling the operator to quit", () => {
    expect(watchdogOutcome("ready", 1)).toEqual({ toast: "", retry: false });
    const startingZombie = watchdogOutcome("zombie", 1);
    expect(startingZombie.retry).toBe(true);
    expect(startingZombie.toast).toBe(cdpStartingCopy());
    expect(startingZombie.toast).not.toMatch(/完全退出/);
    expect(watchdogOutcome("zombie", 0)).toEqual({ toast: cdpWatchdogCopy(), retry: false });
    const starting = watchdogOutcome("absent", 1);
    expect(starting.retry).toBe(true);
    expect(starting.toast).toBe(cdpStartingCopy());
    expect(starting.toast).not.toMatch(/完全退出/);
    const timedOut = watchdogOutcome("absent", 0);
    expect(timedOut.retry).toBe(false);
    expect(timedOut.toast.length).toBeGreaterThan(0);
    expect(timedOut.toast).not.toBe(cdpWatchdogCopy());
  });
});

describe("tryClaimExclusive", () => {
  test("second open-workspace is ignored while the first is in flight", () => {
    const gate = { claimed: false };
    expect(tryClaimExclusive(gate)).toBe(true);
    expect(tryClaimExclusive(gate)).toBe(false);
    expect(gate.claimed).toBe(true);
    gate.claimed = false;
    expect(tryClaimExclusive(gate)).toBe(true);
  });
});

describe("advanceZombiePoll", () => {
  test("overlapping ticks launch only once", () => {
    const gate: ZombiePollGate = { claimed: false, absentTicks: 0 };
    expect(advanceZombiePoll(gate, "absent").action).toBe("wait");
    expect(advanceZombiePoll(gate, "absent").action).toBe("wait");
    expect(advanceZombiePoll(gate, "absent")).toEqual({ action: "launch", absentTicks: 3 });
    expect(advanceZombiePoll(gate, "absent")).toEqual({ action: "wait", absentTicks: 3 });
    expect(gate.claimed).toBe(true);
  });
});

describe("macos launcher script", () => {
  test("does not force a second Cursor with open -n", () => {
    const script = readFileSync(join(import.meta.dir, "../../scripts/armada-cursor.sh"), "utf8");
    expect(script).toContain('open -a "Cursor"');
    expect(script).not.toMatch(/open\s+-na\b/);
    expect(script).not.toMatch(/open\s+-n\s/);
  });
});

describe("copy", () => {
  test("zombie and watchdog copy mention quit, not kill", () => {
    const zombie = cdpZombieCopy();
    const dog = cdpWatchdogCopy();
    expect(zombie).toMatch(/Cmd\+Q|托盘/);
    expect(zombie.toLowerCase()).not.toMatch(/kill -9|kill -9/);
    expect(dog).toMatch(/单实例吞掉了调试口/);
    expect(cdpStartingCopy()).toMatch(/正在启动|请稍候/);
    expect(cdpStartingCopy().toLowerCase()).not.toMatch(/kill -9/);
    expect(cdpStatusLabel("ready")).toMatch(/就绪/);
    expect(cdpStatusLabel("zombie")).toMatch(/残实例/);
    expect(cdpStatusLabel("absent")).toMatch(/未运行/);
  });
});
