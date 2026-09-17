import { describe, expect, test } from "bun:test";
import { hubRunsNeedingTranscriptFollow, shouldArmFollowupStopOnAdopt } from "../src/adoptRuns";
import { FollowupStopGuard } from "../src/transcriptBind";

const mine = "m-win";

describe("hubRunsNeedingTranscriptFollow", () => {
  test("adopts this machine's running run that already has a conversation", () => {
    const got = hubRunsNeedingTranscriptFollow(mine, [
      { id: "r-live", machine_id: mine, status: "running", conversation_id: "cid-1", workspace_root: "c:\\ws", prompt: "hi", live_generation_id: "hub-g1" },
      { id: "r-other", machine_id: "m-mac", status: "running", conversation_id: "cid-x", workspace_root: "/ws", prompt: "x" },
      { id: "r-done", machine_id: mine, status: "completed", conversation_id: "cid-2", workspace_root: "c:\\ws", prompt: "old" },
      { id: "r-bind", machine_id: mine, status: "binding", conversation_id: null, workspace_root: "c:\\ws", prompt: "wait" },
    ]);
    expect(got).toEqual([
      { runId: "r-live", conversationId: "cid-1", workspaceRoot: "c:\\ws", prompt: "hi", liveGenerationId: "hub-g1" },
    ]);
  });
});

describe("shouldArmFollowupStopOnAdopt", () => {
  // 2026-09-17 r-182f5c19: followup user already tailed, WS 1006, adopt re-armed,
  // later turn_ended synthesized stop dropped → 运行中.
  test("reconnect of an already-bound run never re-arms (mid-turn or after turn_ended)", () => {
    expect(shouldArmFollowupStopOnAdopt({ alreadyBound: true, lastRecordIsTurnEnded: false })).toBe(false);
    expect(shouldArmFollowupStopOnAdopt({ alreadyBound: true, lastRecordIsTurnEnded: true })).toBe(false);
  });

  test("fresh adopt arms only when EOF is already turn_ended (stale previous stop)", () => {
    expect(shouldArmFollowupStopOnAdopt({ alreadyBound: false, lastRecordIsTurnEnded: true })).toBe(true);
    expect(shouldArmFollowupStopOnAdopt({ alreadyBound: false, lastRecordIsTurnEnded: false })).toBe(false);
  });

  test("followup user then WS reconnect still emits stop on later turn_ended", () => {
    const g = new FollowupStopGuard();
    g.arm("r-182f5c19");
    g.onUser("r-182f5c19");
    expect(g.shouldEmitStop("r-182f5c19")).toBe(true);
    if (shouldArmFollowupStopOnAdopt({ alreadyBound: true, lastRecordIsTurnEnded: false })) {
      g.arm("r-182f5c19");
    }
    expect(g.shouldEmitStop("r-182f5c19")).toBe(true);
  });
});
