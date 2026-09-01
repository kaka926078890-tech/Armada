import { describe, expect, test } from "bun:test";
import {
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
