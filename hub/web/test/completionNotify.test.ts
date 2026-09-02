import { describe, expect, test } from "bun:test";
import type { RunRow } from "../src/boardState";
import {
  BASE_TITLE, completionHeadline, shouldAlert, seedRunStatus, takeNewlyAlertable,
} from "../src/completionNotify";

const base: RunRow = {
  id: "r-1", machine_id: "m-1", window_id: "w-1", workspace_root: "/ws/a",
  prompt: "fix the bug", status: "running", conversation_id: "c1",
  transcript_path: null, parent_run_id: null, created_at: 1000, started_at: 2000,
  ended_at: null, end_reason: null,
};

describe("takeNewlyAlertable", () => {
  test("does not fire on seed snapshot", () => {
    const prev = seedRunStatus([{ ...base, status: "completed", ended_at: 9 }]);
    expect(takeNewlyAlertable(prev, [{ ...base, status: "completed", ended_at: 9 }])).toEqual([]);
  });

  test("fires once when running becomes completed", () => {
    const prev = seedRunStatus([base]);
    const done = { ...base, status: "completed", ended_at: 9 };
    expect(takeNewlyAlertable(prev, [done]).map((r) => r.id)).toEqual(["r-1"]);
    expect(takeNewlyAlertable(prev, [done])).toEqual([]);
  });

  test("followup complete after another running cycle fires again", () => {
    const prev = seedRunStatus([{ ...base, status: "completed", ended_at: 9 }]);
    const running = { ...base, status: "running", ended_at: null };
    expect(takeNewlyAlertable(prev, [running])).toEqual([]);
    expect(takeNewlyAlertable(prev, [{ ...base, status: "completed", ended_at: 20 }]).map((r) => r.id)).toEqual(["r-1"]);
  });

  test("new completed id that was never seen does not fire (avoid refresh false positive)", () => {
    const prev = seedRunStatus([base]);
    const other = { ...base, id: "r-2", status: "completed", ended_at: 9 };
    expect(takeNewlyAlertable(prev, [base, other])).toEqual([]);
  });

  test("running -> error/unknown/aborted fires; cancelled does not", () => {
    const prevErr = seedRunStatus([base]);
    expect(takeNewlyAlertable(prevErr, [{ ...base, status: "error" }]).map((r) => r.id)).toEqual(["r-1"]);
    const prevUnk = seedRunStatus([base]);
    expect(takeNewlyAlertable(prevUnk, [{ ...base, status: "unknown" }]).map((r) => r.id)).toEqual(["r-1"]);
    const prevAbort = seedRunStatus([base]);
    expect(takeNewlyAlertable(prevAbort, [{ ...base, status: "aborted" }]).map((r) => r.id)).toEqual(["r-1"]);
    const prevCancel = seedRunStatus([base]);
    expect(takeNewlyAlertable(prevCancel, [{ ...base, status: "cancelled" }])).toEqual([]);
  });
});

describe("completionHeadline / shouldAlert", () => {
  test("single vs many", () => {
    expect(completionHeadline([{ ...base, prompt: "hello" }])).toContain("【完成】hello");
    expect(completionHeadline([base, { ...base, id: "r-2" }])).toContain("【2 个任务完成】");
    expect(completionHeadline([])).toBe(BASE_TITLE);
  });

  test("skip only when watching that run (detail open), even if tab would be hidden", () => {
    expect(shouldAlert(base, { watchingId: "r-1" })).toBe(false);
    expect(shouldAlert(base, { watchingId: "other" })).toBe(true);
    expect(shouldAlert(base, { watchingId: null })).toBe(true);
  });
});
