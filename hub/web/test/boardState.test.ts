import { describe, expect, test } from "bun:test";
import { groupRuns, cardView, type RunRow } from "../src/boardState";

const base: RunRow = {
  id: "r-1", machine_id: "m-1", window_id: "w-1", workspace_root: "/ws/a",
  prompt: "fix the bug in the parser", status: "running", conversation_id: "c1",
  transcript_path: null, parent_run_id: null, created_at: 1000, started_at: 2000,
  ended_at: null, end_reason: null,
};

describe("groupRuns", () => {
  test("maps statuses to 5 columns", () => {
    const runs = [
      { ...base, id: "1", status: "dispatched" },
      { ...base, id: "2", status: "binding" },
      { ...base, id: "3", status: "running" },
      { ...base, id: "4", status: "completed" },
      { ...base, id: "5", status: "cancelled" },
      { ...base, id: "6", status: "aborted" },
      { ...base, id: "7", status: "error" },
      { ...base, id: "8", status: "unknown" },
    ];
    const g = groupRuns(runs);
    expect(g.waiting.map((r) => r.id)).toEqual(["1", "2"]);
    expect(g.running.map((r) => r.id)).toEqual(["3"]);
    expect(g.completed.map((r) => r.id)).toEqual(["4"]);
    expect(g.cancelled.map((r) => r.id)).toEqual(["5", "6"]);
    expect(g.error.map((r) => r.id)).toEqual(["7", "8"]);
  });
});

describe("cardView", () => {
  test("title truncates prompt at 40 chars", () => {
    const v = cardView({ ...base, prompt: "x".repeat(100) }, 5000);
    expect(v.title).toHaveLength(41); // 40 + …
    expect(v.title.endsWith("…")).toBe(true);
  });
  test("elapsed from started_at for running", () => {
    const v = cardView(base, 62_000);
    expect(v.elapsed).toBe("60s");
  });
  test("waiting badge text", () => {
    const v = cardView({ ...base, status: "dispatched" }, 5000);
    expect(v.badge).toBe("待本机回车");
  });
  test("binding badge is 绑定中, not 待本机回车", () => {
    const v = cardView({ ...base, status: "binding" }, 5000);
    expect(v.badge).toBe("绑定中");
  });
});
