import { describe, expect, test } from "bun:test";
import {
  afterOpenWorkspaceFeedback,
  cdpStatusLabel,
  cdpWatchdogCopy,
  cdpZombieCopy,
  classifyCdp,
  shouldRunLauncher,
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
  test("watchdog clears on ready, else watchdog copy", () => {
    expect(afterOpenWorkspaceFeedback("watchdog", "ready")).toBe("");
    expect(afterOpenWorkspaceFeedback("watchdog", "zombie")).toBe(cdpWatchdogCopy());
    expect(afterOpenWorkspaceFeedback("watchdog", "absent")).toBe(cdpWatchdogCopy());
  });

  test("zombie-poll continues until user quits or CDP recovers", () => {
    expect(afterOpenWorkspaceFeedback("zombie-poll", "zombie")).toBe("continue");
    expect(afterOpenWorkspaceFeedback("zombie-poll", "absent")).toBe("clear");
    expect(afterOpenWorkspaceFeedback("zombie-poll", "ready")).toBe("stop");
  });
});

describe("copy", () => {
  test("zombie and watchdog copy mention quit, not kill", () => {
    const zombie = cdpZombieCopy();
    const dog = cdpWatchdogCopy();
    expect(zombie).toMatch(/Cmd\+Q|托盘/);
    expect(zombie.toLowerCase()).not.toMatch(/kill -9|kill -9/);
    expect(dog).toMatch(/单实例吞掉了调试口/);
    expect(cdpStatusLabel("ready")).toMatch(/就绪/);
    expect(cdpStatusLabel("zombie")).toMatch(/残实例/);
    expect(cdpStatusLabel("absent")).toMatch(/未运行/);
  });
});
