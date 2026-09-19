import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  IDLE_RELOAD_MAX_WAIT_MS,
  decideReloadFire,
  decideWindowReload,
  noteReloadCommandSettled,
  parsePendingReload,
  pendingFromAction,
  reloadStillNeeded,
  reloadStillNeededForFleet,
  windowHasInFlightArmadaRun,
  type ReloadFireState,
} from "../src/cursorReload";

describe("parsePendingReload", () => {
  test("keeps now/when-idle and drops skip or junk", () => {
    expect(parsePendingReload({ action: "now", vsix: "0.4.27", setAt: 10, notBefore: 10, machineId: "m-win" })).toEqual({
      action: "now", vsix: "0.4.27", setAt: 10, notBefore: 10, machineId: "m-win",
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
    expect(pendingFromAction("when-idle", "0.4.27", 50, 80, "m-1")).toEqual({
      action: "when-idle", vsix: "0.4.27", setAt: 50, notBefore: 80, machineId: "m-1",
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

  test("ignores a pending aimed at a different machine", () => {
    expect(decideWindowReload({
      pending: { ...pending, machineId: "m-win" },
      thisWindowHasLiveRun: false,
      now: 2000,
      machineId: "m-mac",
    })).toBe("none");
  });
});

describe("decideReloadFire", () => {
  const idle: ReloadFireState = { lastFiredSetAt: null, lastDecision: null, inFlight: false };
  const setAt = 1000;

  test("fires once when idle reload is decided", () => {
    const r = decideReloadFire(idle, { decision: "reload", pendingSetAt: setAt });
    expect(r.fire).toBe(true);
    expect(r.next.inFlight).toBe(true);
    expect(r.next.lastFiredSetAt).toBe(setAt);
  });

  test("does not re-fire the same pending after reloadWindow left the window alive", () => {
    const first = decideReloadFire(idle, { decision: "reload", pendingSetAt: setAt });
    const survived = noteReloadCommandSettled(first.next);
    const again = decideReloadFire(survived, { decision: "reload", pendingSetAt: setAt });
    expect(again.fire).toBe(false);
  });

  test("holds while reloadWindow is still in flight (Cursor confirmation dialog)", () => {
    const first = decideReloadFire(idle, { decision: "reload", pendingSetAt: setAt });
    const stacked = decideReloadFire(first.next, { decision: "reload", pendingSetAt: setAt });
    expect(stacked.fire).toBe(false);
  });

  test("fires again after a busy→idle edge on the same pending", () => {
    const first = decideReloadFire(idle, { decision: "reload", pendingSetAt: setAt });
    const survived = noteReloadCommandSettled(first.next);
    const busy = decideReloadFire(survived, { decision: "wait", pendingSetAt: setAt });
    expect(busy.fire).toBe(false);
    const idleAgain = decideReloadFire(busy.next, { decision: "reload", pendingSetAt: setAt });
    expect(idleAgain.fire).toBe(true);
  });

  test("new pending setAt can fire even if the previous attempt survived", () => {
    const first = decideReloadFire(idle, { decision: "reload", pendingSetAt: setAt });
    const survived = noteReloadCommandSettled(first.next);
    const nextPending = decideReloadFire(survived, { decision: "reload", pendingSetAt: setAt + 1 });
    expect(nextPending.fire).toBe(true);
  });

  test("expired/done/none never fire", () => {
    expect(decideReloadFire(idle, { decision: "expired", pendingSetAt: setAt }).fire).toBe(false);
    expect(decideReloadFire(idle, { decision: "done", pendingSetAt: setAt }).fire).toBe(false);
    expect(decideReloadFire(idle, { decision: "none", pendingSetAt: null }).fire).toBe(false);
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

describe("reloadStillNeededForFleet", () => {
  const pending = { action: "when-idle" as const, vsix: "0.4.27", setAt: 1, notBefore: 1 };
  test("ignores offline stale installs", () => {
    expect(reloadStillNeededForFleet(pending, [
      { id: "old", status: "offline", extension_version: "0.4.18" },
      { id: "mac", status: "online", extension_version: "0.4.27" },
    ])).toBe(false);
  });
  test("stays needed while an online machine is behind", () => {
    expect(reloadStillNeededForFleet(pending, [
      { id: "mac", status: "online", extension_version: "0.4.27" },
      { id: "win", status: "online", extension_version: "0.4.26" },
    ])).toBe(true);
  });
  test("scoped pending only looks at that online machine", () => {
    expect(reloadStillNeededForFleet({ ...pending, machineId: "win" }, [
      { id: "mac", status: "online", extension_version: "0.4.27" },
      { id: "win", status: "online", extension_version: "0.4.26" },
    ])).toBe(true);
    expect(reloadStillNeededForFleet({ ...pending, machineId: "mac" }, [
      { id: "mac", status: "online", extension_version: "0.4.27" },
      { id: "win", status: "online", extension_version: "0.4.26" },
    ])).toBe(false);
  });
});

describe("windowHasInFlightArmadaRun", () => {
  test("pending start is in-flight even with no binds", () => {
    expect(windowHasInFlightArmadaRun({
      pendingStartCount: 1,
      boundRunIds: [],
      stopSentRunIds: [],
    })).toBe(true);
  });

  test("bound run with no stop is in-flight", () => {
    expect(windowHasInFlightArmadaRun({
      pendingStartCount: 0,
      boundRunIds: ["r-live"],
      stopSentRunIds: [],
    })).toBe(true);
  });

  test("synthesized completed bind is idle; keep boundRuns for followup", () => {
    expect(windowHasInFlightArmadaRun({
      pendingStartCount: 0,
      boundRunIds: ["r-bcdccf9d"],
      stopSentRunIds: ["r-bcdccf9d"],
    })).toBe(false);
  });

  test("followup that cleared stopSent is in-flight again", () => {
    expect(windowHasInFlightArmadaRun({
      pendingStartCount: 0,
      boundRunIds: ["r-bcdccf9d"],
      stopSentRunIds: [],
    })).toBe(true);
  });

  test("one completed bind does not hide a still-running bind", () => {
    expect(windowHasInFlightArmadaRun({
      pendingStartCount: 0,
      boundRunIds: ["r-done", "r-live"],
      stopSentRunIds: ["r-done"],
    })).toBe(true);
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

describe("extension delivers hub reload over ws", () => {
  test("poll and ext.cursorReload share decideWindowReload", () => {
    const src = readFileSync(join(import.meta.dir, "../../extension/src/extension.ts"), "utf8");
    expect(src).toContain("case \"ext.cursorReload\"");
    expect(src).toContain("machineId: machineId");
    expect(src).toContain("windowHasInFlightArmadaRun");
    expect(src).toContain("decideReloadFire");
    expect(src).toContain("noteReloadCommandSettled");
    expect(src).not.toContain("boundRuns.size > 0 || pendingRuns.length > 0");
  });
});
