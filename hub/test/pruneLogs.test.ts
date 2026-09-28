import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { LOG_RETENTION_MS, pruneHubLogs } from "../src/pruneLogs";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "armada-prune-"));
  return openDb(home);
}

const day = 24 * 60 * 60 * 1000;

describe("pruneHubLogs", () => {
  test("drops terminal events and audit older than a week, keeps the run and live events", () => {
    const db = setup();
    const now = Date.now();
    db.query("INSERT INTO machines (id, name, os, open_workspaces) VALUES ('m1','n','darwin','[]')").run();
    db.query(
      `INSERT INTO runs (id, machine_id, workspace_root, prompt, status, created_at, ended_at)
       VALUES ('old','m1','/ws','p','completed',?1,?1),
              ('fresh','m1','/ws','p','completed',?2,?2),
              ('live','m1','/ws','p','running',?1,NULL)`,
    ).run(now - 8 * day, now - day);
    const ins = db.query(
      `INSERT INTO run_events (run_id, seq, machine_id, ext_seq, source, hook_event_name, payload, ts)
       VALUES (?1,1,'m1',?2,'hook','x','{}',?3)`,
    );
    ins.run("old", 1, now - 8 * day);
    ins.run("fresh", 2, now - day);
    ins.run("live", 3, now - 8 * day);
    db.query("INSERT INTO audit (ts, actor, action, payload) VALUES (?1,'hub','old','{}'), (?2,'hub','new','{}')")
      .run(now - 8 * day, now - day);

    const pruned = pruneHubLogs(db, now, LOG_RETENTION_MS);
    expect(pruned).toEqual({ events: 1, audit: 1 });
    const left = db.query("SELECT run_id FROM run_events ORDER BY ext_seq").all() as { run_id: string }[];
    expect(left.map((r) => r.run_id)).toEqual(["fresh", "live"]);
    expect(db.query("SELECT id FROM runs ORDER BY id").all()).toEqual([
      { id: "fresh" }, { id: "live" }, { id: "old" },
    ]);
    const audit = db.query("SELECT action FROM audit").all() as { action: string }[];
    expect(audit.map((r) => r.action)).toEqual(["new"]);
  });
});
