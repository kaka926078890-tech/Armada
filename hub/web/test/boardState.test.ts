import { describe, expect, test } from "bun:test";
import {
  groupRuns, cardView, listWorkspaceSlots, encodeWorkspaceKey, decodeWorkspaceKey,
  filterRunsByWorkspace, sortConversations, groupSlotsByMachine, isUnreadCompleted, isUnreadMessage,
  workspaceHasUnread, canArchiveRun, isHubArchived, type RunRow,
} from "../src/boardState";

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
  test("queued sits in waiting with 排队中 badge", () => {
    const g = groupRuns([{ ...base, id: "q", status: "queued" }]);
    expect(g.waiting.map((r) => r.id)).toEqual(["q"]);
    expect(cardView({ ...base, status: "queued" }, 5000).badge).toBe("排队中");
  });
});

describe("workspace slots and conversation filter", () => {
  test("lists open workspaces as a flat menu, skips bad json", () => {
    const slots = listWorkspaceSlots([
      { id: "m-1", name: "a", os: "darwin", status: "online", open_workspaces: '["/ws/a","/ws/b"]' },
      { id: "m-2", name: "b", os: "darwin", status: "offline", open_workspaces: "not-json" },
    ]);
    expect(slots.map((s) => s.root)).toEqual(["/ws/a", "/ws/b"]);
    expect(slots[0].online).toBe(true);
  });

  test("groupSlotsByMachine nests workspaces under each computer", () => {
    const grouped = groupSlotsByMachine(listWorkspaceSlots([
      { id: "m-a", name: "电脑A", os: "darwin", status: "online", open_workspaces: '["/ws/a","/ws/b"]' },
      { id: "m-b", name: "电脑B", os: "darwin", status: "online", open_workspaces: '["/ws/a","/ws/b"]' },
    ]));
    expect(grouped.map((g) => g.machineName)).toEqual(["电脑A", "电脑B"]);
    expect(grouped[0].workspaces.map((w) => w.root.split("/").pop())).toEqual(["a", "b"]);
    expect(grouped[1].workspaces.map((w) => w.root.split("/").pop())).toEqual(["a", "b"]);
  });

  test("encode/decode workspace key round-trips paths with pipes", () => {
    const k = encodeWorkspaceKey("m-1", "/tmp/a|b");
    expect(decodeWorkspaceKey(k)).toEqual({ machineId: "m-1", root: "/tmp/a|b" });
    expect(decodeWorkspaceKey(null)).toBeNull();
  });

  test("filterRunsByWorkspace is machine+root, not basename", () => {
    const runs: RunRow[] = [
      { ...base, id: "1", machine_id: "m-1", workspace_root: "/ws/a" },
      { ...base, id: "2", machine_id: "m-1", workspace_root: "/other/a" },
      { ...base, id: "3", machine_id: "m-2", workspace_root: "/ws/a" },
    ];
    expect(filterRunsByWorkspace(runs, "m-1", "/ws/a").map((r) => r.id)).toEqual(["1"]);
  });

  test("sortConversations puts live runs first then newest", () => {
    const sorted = sortConversations([
      { ...base, id: "old-done", status: "completed", created_at: 9 },
      { ...base, id: "new-done", status: "completed", created_at: 30 },
      { ...base, id: "live", status: "running", created_at: 1 },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["live", "new-done", "old-done"]);
  });
});

describe("unread dots", () => {
  test("completed never opened is unread completed and workspace badge", () => {
    const run = { ...base, status: "completed", ended_at: 5000 };
    expect(isUnreadCompleted(run, undefined)).toBe(true);
    expect(workspaceHasUnread([run], {})).toBe(true);
    expect(isUnreadCompleted(run, 6000)).toBe(false);
  });

  test("running never opened is a workspace message dot, not completed unread", () => {
    expect(isUnreadMessage(base, undefined)).toBe(true);
    expect(isUnreadCompleted(base, undefined)).toBe(false);
  });

  test("workspace badge is completed-unread only; running does not light the dot", () => {
    expect(workspaceHasUnread([base], {})).toBe(false);
    expect(workspaceHasUnread([{ ...base, status: "error", ended_at: 5000 }], {})).toBe(false);
    expect(workspaceHasUnread([{ ...base, status: "completed", ended_at: 5000 }], {})).toBe(true);
  });

  test("cancelled does not badge", () => {
    const run = { ...base, status: "cancelled", ended_at: 9 };
    expect(isUnreadMessage(run, undefined)).toBe(false);
    expect(workspaceHasUnread([run], {})).toBe(false);
  });

  test("display_name wins over hostname in the tree", () => {
    const slots = listWorkspaceSlots([
      { id: "m-1", name: "A.local", display_name: "办公室 Mac", os: "darwin", status: "online", open_workspaces: '["/ws/a"]' },
    ]);
    expect(slots[0].machineName).toBe("办公室 Mac");
  });

  test("canArchiveRun forbids live statuses", () => {
    expect(canArchiveRun({ status: "running" })).toBe(false);
    expect(canArchiveRun({ status: "queued" })).toBe(false);
    expect(canArchiveRun({ status: "completed" })).toBe(true);
    expect(isHubArchived({ archived_at: 9 })).toBe(true);
    expect(isHubArchived({ archived_at: null })).toBe(false);
  });
});
