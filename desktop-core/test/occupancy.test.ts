import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { decideOccupancy, restoreAttachCopy, restoreDecisionNotice } from "../src/occupancy";

test("reuse owned child", () => {
  expect(decideOccupancy({
    ownedPidAlive: true, portOpen: true,
    health: { ok: true, name: "armada-hub" }, machinesStatus: 200,
  })).toEqual({ action: "reuse-owned" });
});

test("spawn when port free", () => {
  expect(decideOccupancy({
    ownedPidAlive: false, portOpen: false,
    health: "unreachable", machinesStatus: "skipped",
  })).toEqual({ action: "spawn" });
});

test("attach same-token hub", () => {
  expect(decideOccupancy({
    ownedPidAlive: false, portOpen: true,
    health: { ok: true, name: "armada-hub" }, machinesStatus: 200,
  })).toEqual({ action: "attach" });
});

test("block foreign armada", () => {
  expect(decideOccupancy({
    ownedPidAlive: false, portOpen: true,
    health: { ok: true, name: "armada-hub" }, machinesStatus: 401,
  })).toEqual({ action: "block", reason: "foreign-armada" });
});

test("block other process", () => {
  expect(decideOccupancy({
    ownedPidAlive: false, portOpen: true,
    health: { ok: true, name: "nginx" }, machinesStatus: "skipped",
  })).toEqual({ action: "block", reason: "port-busy" });
  expect(decideOccupancy({
    ownedPidAlive: false, portOpen: true,
    health: "unreachable", machinesStatus: "skipped",
  })).toEqual({ action: "block", reason: "port-busy" });
});

test("restore path surfaces attach as not this app spawn", () => {
  const d = decideOccupancy({
    ownedPidAlive: false, portOpen: true,
    health: { ok: true, name: "armada-hub" }, machinesStatus: 200,
  });
  expect(d).toEqual({ action: "attach" });
  expect(restoreDecisionNotice(d.action)).toBe(restoreAttachCopy());
  expect(restoreAttachCopy()).toMatch(/非本应用启动/);
  expect(restoreDecisionNotice("spawn")).toBeNull();
  expect(restoreDecisionNotice("reuse-owned")).toBeNull();
});

test("restoreOwnedHub toasts attach instead of silently opening the board", () => {
  const main = readFileSync(join(import.meta.dir, "../../desktop/src/main.ts"), "utf8");
  const restore = main.slice(main.indexOf("async function restoreOwnedHub"));
  const body = restore.slice(0, restore.indexOf("\nfunction "));
  expect(body).toContain("restoreDecisionNotice");
  expect(body).toMatch(/r\.decision/);
  expect(body).toContain("showToast");
  expect(body).toContain("openBoard");
});
