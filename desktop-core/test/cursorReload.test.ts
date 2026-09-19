import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  IDLE_RELOAD_MAX_WAIT_MS,
  decideWindowReload,
  parsePendingReload,
  pendingFromAction,
  reloadStillNeeded,
} from "../src/cursorReload";

describe("parsePendingReload", () => {
  test("keeps now/when-idle and drops skip or junk", () => {
    expect(parsePendingReload({ action: "now", vsix: "0.4.27", setAt: 10, notBefore: 10 })).toEqual({
      action: "now", vsix: "0.4.27", setAt: 10, notBefore: 10,
    });
    expect(parsePendingReload({ action: "when-idle", vsix: "0.4.27", setAt: 10 })).toEqual({
      action: "when-idle", vsix: "0.4.27", setAt: 10, notBefore: 10,
    });
    expect(parsePendingReload({ action: "skip", vsix: "0.4.27", setAt: 10 })).toBeNull();
    expect(parsePendingReload(null)).toBeNull();
    expect(parsePendingReload({ action: "now", vsix: "", setAt: 10 })).toBeNull();
  });
});

describe("pendingFromAction", () => {
  test("skip clears; now/when-idle require a vsix", () => {
    expect(pendingFromAction("skip", "0.4.27", 50)).toBeNull();
    expect(pendingFromAction("now", "0.4.27", 50)).toEqual({
      action: "now", vsix: "0.4.27", setAt: 50, notBefore: 50,
    });
    expect(pendingFromAction("when-idle", "0.4.27", 50, 80)).toEqual({
      action: "when-idle", vsix: "0.4.27", setAt: 50, notBefore: 80,
    });
    expect(pendingFromAction("now", "  ", 50)).toBeNull();
  });
});

describe("decideWindowReload", () => {
  const pending = { action: "when-idle" as const, vsix: "0.4.27", setAt: 1000, notBefore: 1000 };

  test("no pending is none", () => {
    expect(decideWindowReload({ pending: null, thisWindowHasLiveRun: false, now: 2000 })).toBe("none");
  });

  test("waits until notBefore even when idle", () => {
    expect(decideWindowReload({
      pending: { ...pending, notBefore: 5000 },
      thisWindowHasLiveRun: false,
      now: 2000,
    })).toBe("wait");
  });

  test("does not reload while this window still has an Armada live run", () => {
    expect(decideWindowReload({ pending, thisWindowHasLiveRun: true, now: 2000 })).toBe("wait");
  });

  test("now reloads even while this window has an Armada live run", () => {
    expect(decideWindowReload({
      pending: { ...pending, action: "now" },
      thisWindowHasLiveRun: true,
      now: 2000,
    })).toBe("reload");
  });

  test("reloads when idle after notBefore", () => {
    expect(decideWindowReload({ pending, thisWindowHasLiveRun: false, now: 2000 })).toBe("reload");
  });

  test("expires instead of forcing after the idle wait cap", () => {
    expect(decideWindowReload({
      pending,
      thisWindowHasLiveRun: true,
      now: 1000 + IDLE_RELOAD_MAX_WAIT_MS,
    })).toBe("expired");
  });

  test("done when this window already runs the pending vsix", () => {
    expect(decideWindowReload({
      pending,
      thisWindowHasLiveRun: false,
      now: 2000,
      runningVsix: "0.4.27",
    })).toBe("done");
  });
});

describe("reloadStillNeeded", () => {
  const pending = { action: "when-idle" as const, vsix: "0.4.27", setAt: 1, notBefore: 1 };
  test("needed until every reported install is at least the pending vsix", () => {
    expect(reloadStillNeeded(null, ["0.4.26"])).toBe(false);
    expect(reloadStillNeeded(pending, [])).toBe(true);
    expect(reloadStillNeeded(pending, ["0.4.26"])).toBe(true);
    expect(reloadStillNeeded(pending, ["0.4.27", "0.4.26"])).toBe(true);
    expect(reloadStillNeeded(pending, ["0.4.27", "0.4.28"])).toBe(false);
  });
});

describe("detached schedule script", () => {
  test("ignores HUP and writes the shipped vsix, not a placeholder", () => {
    const script = readFileSync(join(import.meta.dir, "../../desktop/scripts/schedule-cursor-reload.sh"), "utf8");
    expect(script).toContain("trap '' HUP");
    expect(script).toContain("extension/package.json");
    expect(script).not.toContain('"vsix": "pending"');
  });
});
