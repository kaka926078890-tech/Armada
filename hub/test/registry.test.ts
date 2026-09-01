import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { Registry, workspaceListChanged } from "../src/registry";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "armada-reg-"));
  const db = openDb(home);
  return { db, reg: new Registry(db) };
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
    expect(names).toContain("audit");
  });

  test("workspaceListChanged is order-insensitive", () => {
    expect(workspaceListChanged(["/a", "/b"], ["/b", "/a"])).toBe(false);
    expect(workspaceListChanged(["/a"], ["/a", "/b"])).toBe(true);
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
});
