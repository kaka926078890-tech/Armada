import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { Registry, workspaceListChanged, pickOpenWindowExecutor } from "../src/registry";
import type { ArmadaSocket } from "../src/ws";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "armada-reg-"));
  const db = openDb(home);
  return { db, reg: new Registry(db) };
}

function fakeWs(): ArmadaSocket {
  return { data: { registered: false }, send() {}, close() {} };
}

function register(reg: Registry, ws: ArmadaSocket, extra: Record<string, unknown> = {}) {
  reg.onRegister(ws, {
    machineId: "m-1", windowId: "w-1", name: "Mac-A", os: "darwin-arm64",
    openWorkspaces: ["/ws/a"],
    ...extra,
  });
}

const machine = {
  id: "m-1", name: "Mac-A", os: "darwin-arm64",
  cursorVersion: "1.7.38", extensionVersion: "0.1.0",
  openWorkspaces: ["/ws/a", "/ws/b"],
};

describe("Registry", () => {
  test("upsertMachine inserts then updates workspaces + online", () => {
    const { reg } = setup();
    reg.upsertMachine(machine);
    reg.upsertMachine({ ...machine, openWorkspaces: ["/ws/c"] });
    const rows = reg.listMachines();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("m-1");
    expect(JSON.parse(rows[0].open_workspaces)).toEqual(["/ws/c"]);
    expect(rows[0].status).toBe("online");
    expect(rows[0].last_seen_at).toBeGreaterThan(0);
  });

  test("markOffline flips status", () => {
    const { reg } = setup();
    reg.upsertMachine(machine);
    reg.markOffline("m-1");
    expect(reg.getMachine("m-1")!.status).toBe("offline");
  });

  test("getMachine returns null for unknown", () => {
    const { reg } = setup();
    expect(reg.getMachine("nope")).toBeNull();
  });

  test("schema has runs/run_events/audit tables", () => {
    const { db } = setup();
    const names = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
    expect(names).toContain("machines");
    expect(names).toContain("runs");
    expect(names).toContain("run_events");
    expect(names).toContain("run_outbound");
  });

  test("workspaceListChanged is order-insensitive", () => {
    expect(workspaceListChanged(["/a", "/b"], ["/b", "/a"])).toBe(false);
    expect(workspaceListChanged(["/a"], ["/a", "/b"])).toBe(true);
  });

  test("register without machineId/windowId/os closes 4001 and does not upsert", () => {
    const { reg } = setup();
    const closed: { code?: number; reason?: string }[] = [];
    const ws: ArmadaSocket = {
      data: { registered: false },
      send() {},
      close(code?: number, reason?: string) { closed.push({ code, reason }); },
    };
    for (const msg of [
      { windowId: "w-1", name: "Mac-A", os: "darwin-arm64" },
      { machineId: "m-1", name: "Mac-A", os: "darwin-arm64" },
      { machineId: "m-1", windowId: "w-1", name: "Mac-A" },
      { machineId: 1, windowId: "w-1", name: "Mac-A", os: "darwin-arm64" },
    ]) {
      closed.length = 0;
      ws.data.registered = false;
      reg.onRegister(ws, msg);
      expect(closed).toEqual([{ code: 4001, reason: "unauthorized" }]);
      expect(ws.data.registered).toBe(false);
    }
    expect(reg.listMachines()).toHaveLength(0);
  });

  test("register notifies machines changed even when union matches upsert", () => {
    const { reg } = setup();
    let n = 0;
    reg.onMachinesChanged = () => { n += 1; };
    const ws = { data: { registered: false } as { registered: boolean; connKey?: string; machineId?: string; windowId?: string }, send() {}, close() {} };
    reg.onRegister(ws, {
      machineId: "m-1", windowId: "w-1", name: "Mac-A", os: "darwin-arm64",
      openWorkspaces: ["/ws/new"],
    });
    expect(n).toBe(1);
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces)).toEqual(["/ws/new"]);
  });

  test("heartbeat notifies only when workspace union changes", () => {
    const { reg } = setup();
    const ws = { data: { registered: false } as { registered: boolean; connKey?: string; machineId?: string; windowId?: string }, send() {}, close() {} };
    reg.onRegister(ws, {
      machineId: "m-1", windowId: "w-1", name: "Mac-A", os: "darwin-arm64",
      openWorkspaces: ["/ws/a"],
    });
    let n = 0;
    reg.onMachinesChanged = () => { n += 1; };
    reg.onHeartbeat(ws, { openWorkspaces: ["/ws/a"] });
    expect(n).toBe(0);
    reg.onHeartbeat(ws, { openWorkspaces: ["/ws/a", "/ws/b"] });
    expect(n).toBe(1);
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces)).toEqual(["/ws/a", "/ws/b"]);
  });

  test("heartbeat stores queueMessageDefaultBehavior", () => {
    const { reg } = setup();
    const ws = fakeWs();
    register(reg, ws);
    reg.onHeartbeat(ws, { openWorkspaces: ["/ws/a"], queueMessageDefaultBehavior: "queue" });
    expect(reg.getMachine("m-1")!.queue_message_default_behavior).toBe("queue");
    reg.onHeartbeat(ws, { openWorkspaces: ["/ws/a"] });
    expect(reg.getMachine("m-1")!.queue_message_default_behavior).toBe("queue");
  });

  test("last window close persists empty open_workspaces and notifies", () => {
    const { reg } = setup();
    const ws = fakeWs();
    let n = 0;
    register(reg, ws);
    reg.onMachinesChanged = () => { n += 1; };
    reg.onClose(ws);
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces)).toEqual([]);
    expect(reg.getMachine("m-1")!.status).toBe("online");
    expect(n).toBe(1);
  });

  test("pickOpenWindowExecutor prefers 0.4.40 peer over busy unrestored window", () => {
    expect(pickOpenWindowExecutor([
      { windowId: "w-busy", openWorkspaces: ["/ws/a"], extensionVersion: "0.4.38" },
      { windowId: "w-peer", openWorkspaces: ["/ws/b"], extensionVersion: "0.4.40" },
    ], "/ws/a")).toBe("w-peer");
  });

  test("pickOpenWindowExecutor skips the window that already has the root", () => {
    expect(pickOpenWindowExecutor([
      { windowId: "w-other", openWorkspaces: ["/ws/b"], extensionVersion: "0.4.40" },
      { windowId: "w-same", openWorkspaces: ["/ws/a"], extensionVersion: "0.4.40" },
    ], "/ws/a")).toBe("w-other");
  });

  test("pickOpenWindowExecutor does not ask the only window to reopen its own folder", () => {
    expect(pickOpenWindowExecutor([
      { windowId: "w-busy", openWorkspaces: ["/ws/a"], extensionVersion: "0.4.38" },
    ], "/ws/a")).toBeNull();
  });

  test("windowsForWorkspace lists every live window of that root", () => {
    const { reg } = setup();
    const a = fakeWs();
    const b = fakeWs();
    register(reg, a, { windowId: "w-1", openWorkspaces: ["/ws/a"] });
    register(reg, b, { windowId: "w-2", openWorkspaces: ["/ws/a"] });
    expect(reg.windowsForWorkspace("m-1", "/ws/a").sort()).toEqual(["w-1", "w-2"]);
    expect(reg.windowsForWorkspace("m-1", "/ws/b")).toEqual([]);
  });

  test("closing one of two windows keeps the other workspace", () => {
    const { reg } = setup();
    const a = fakeWs();
    const b = fakeWs();
    register(reg, a, { windowId: "w-1", openWorkspaces: ["/ws/a"] });
    register(reg, b, { windowId: "w-2", openWorkspaces: ["/ws/b"] });
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces).sort()).toEqual(["/ws/a", "/ws/b"]);
    reg.onClose(a);
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces)).toEqual(["/ws/b"]);
  });

  test("markOffline clears workspaces and notifies", () => {
    const { reg } = setup();
    reg.upsertMachine(machine);
    let n = 0;
    reg.onMachinesChanged = () => { n += 1; };
    reg.markOffline("m-1");
    expect(reg.getMachine("m-1")!.status).toBe("offline");
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces)).toEqual([]);
    expect(n).toBe(1);
  });

  test("heartbeat stores cdpReady and notifies when injectability flips", () => {
    const { reg } = setup();
    const ws = fakeWs();
    register(reg, ws, { cdpReady: true });
    expect(reg.listMachines()[0].cdp_ready).toBe(true);
    expect(reg.routeForInject("m-1", "/ws/a")).toEqual({ ok: true, windowId: "w-1" });
    let n = 0;
    reg.onMachinesChanged = () => { n += 1; };
    reg.onHeartbeat(ws, { openWorkspaces: ["/ws/a"] });
    expect(n).toBe(0);
    expect(reg.routeForInject("m-1", "/ws/a")).toEqual({ ok: true, windowId: "w-1" });
    reg.onHeartbeat(ws, { openWorkspaces: ["/ws/a"], cdpReady: true });
    expect(n).toBe(0);
    reg.onHeartbeat(ws, { openWorkspaces: ["/ws/a"], cdpReady: false });
    expect(n).toBe(1);
    expect(reg.listMachines()[0].cdp_ready).toBe(false);
    expect(reg.routeForInject("m-1", "/ws/a")).toEqual({ ok: false, error: "CDP_NOT_READY" });
    reg.onHeartbeat(ws, { openWorkspaces: ["/ws/a"] });
    expect(reg.routeForInject("m-1", "/ws/a")).toEqual({ ok: false, error: "CDP_NOT_READY" });
  });

  test("missing cdpReady is CDP_NOT_READY; any true window makes machine ready", () => {
    const { reg } = setup();
    const a = fakeWs();
    const b = fakeWs();
    register(reg, a, { windowId: "w-1", openWorkspaces: ["/ws/a"] });
    expect(reg.listMachines()[0].cdp_ready).toBe(false);
    expect(reg.routeForInject("m-1", "/ws/a")).toEqual({ ok: false, error: "CDP_NOT_READY" });
    expect(reg.routeForInject("m-1", "/nope")).toEqual({ ok: false, error: "WORKSPACE_NOT_OPEN" });
    register(reg, b, { windowId: "w-2", openWorkspaces: ["/ws/b"], cdpReady: true });
    expect(reg.listMachines()[0].cdp_ready).toBe(true);
    expect(reg.routeForInject("m-1", "/ws/b")).toEqual({ ok: true, windowId: "w-2" });
  });

  test("offline machine has null cdp_ready", () => {
    const { reg } = setup();
    reg.upsertMachine(machine);
    expect(reg.listMachines()[0].cdp_ready).toBeNull();
  });

  test("constructor clears leftover workspaces on already-offline rows", () => {
    const { db } = setup();
    db.query(`
      INSERT INTO machines (id, name, os, open_workspaces, status)
      VALUES ('m-old', 'Old', 'darwin', ?1, 'offline')
    `).run(JSON.stringify(["/old"]));
    const reg = new Registry(db);
    expect(JSON.parse(reg.getMachine("m-old")!.open_workspaces)).toEqual([]);
    expect(reg.getMachine("m-old")!.status).toBe("offline");
  });

  test("boot leftover online is display-offline without onMachineOffline", () => {
    const home = mkdtempSync(join(tmpdir(), "armada-reg-boot-"));
    const db = openDb(home);
    db.query(`
      INSERT INTO machines (id, name, os, open_workspaces, status, last_seen_at)
      VALUES ('m-1', 'Mac-A', 'darwin', ?1, 'online', ?2)
    `).run(JSON.stringify(["/ws/a"]), Date.now() - 60_000);
    let offline = 0;
    const reg = new Registry(db);
    reg.onMachineOffline = () => { offline += 1; };
    expect(reg.getMachine("m-1")!.status).toBe("offline");
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces)).toEqual([]);
    expect(offline).toBe(0);
    reg.sweep(Date.now());
    expect(offline).toBe(0);
  });

  test("sendToConnected can target one machine or every live socket", () => {
    const { reg } = setup();
    const sent: string[] = [];
    const wsMac = { data: { registered: false }, send(s: string) { sent.push(`mac:${s}`); }, close() {} };
    const wsWin = { data: { registered: false }, send(s: string) { sent.push(`win:${s}`); }, close() {} };
    reg.onRegister(wsMac, {
      machineId: "m-mac", windowId: "w-1", name: "Mac", os: "darwin", openWorkspaces: ["/a"],
    });
    reg.onRegister(wsWin, {
      machineId: "m-win", windowId: "w-2", name: "Win", os: "win32", openWorkspaces: ["/b"],
    });
    sent.length = 0;
    expect(reg.sendToConnected({ type: "ext.cursorReload", pending: null }, "m-win")).toBe(1);
    expect(sent).toEqual(['win:{"type":"ext.cursorReload","pending":null}']);
    sent.length = 0;
    expect(reg.sendToConnected({ type: "ext.cursorReload" })).toBe(2);
  });
});
