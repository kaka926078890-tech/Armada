import { describe, expect, test } from "bun:test";
import { decideOccupancy } from "../src/occupancy";

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
