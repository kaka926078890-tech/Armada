import { describe, expect, test } from "bun:test";
import { hubRunsNeedingTranscriptFollow } from "../src/adoptRuns";

const mine = "m-win";

describe("hubRunsNeedingTranscriptFollow", () => {
  test("adopts this machine's running run that already has a conversation", () => {
    const got = hubRunsNeedingTranscriptFollow(mine, [
      { id: "r-live", machine_id: mine, status: "running", conversation_id: "cid-1", workspace_root: "c:\\ws", prompt: "hi" },
      { id: "r-other", machine_id: "m-mac", status: "running", conversation_id: "cid-x", workspace_root: "/ws", prompt: "x" },
      { id: "r-done", machine_id: mine, status: "completed", conversation_id: "cid-2", workspace_root: "c:\\ws", prompt: "old" },
      { id: "r-bind", machine_id: mine, status: "binding", conversation_id: null, workspace_root: "c:\\ws", prompt: "wait" },
    ]);
    expect(got).toEqual([
      { runId: "r-live", conversationId: "cid-1", workspaceRoot: "c:\\ws", prompt: "hi" },
    ]);
  });
});
