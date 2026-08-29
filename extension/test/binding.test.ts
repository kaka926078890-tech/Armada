import { describe, expect, test } from "bun:test";
import { matchHookToPending, latestRunIdForConversation, claimConversation, type PendingRun } from "../src/binding";

const P: PendingRun = { runId: "r-1", workspaceRoot: "/ws/a", prompt: "hello", dispatchedAt: 1_000_000 };

function ev(hook: string, tsMs: number, raw: any) {
  return { hook, ts: tsMs / 1000, raw };
}

describe("matchHookToPending", () => {
  test("sessionStart never binds (fires at chat creation, before submit)", () => {
    expect(matchHookToPending([P], ev("sessionStart", 1_001_000, { conversation_id: "c1", workspace_roots: ["/ws/a"] }))).toBeNull();
  });

  test("beforeSubmitPrompt with same prompt → true", () => {
    const m = matchHookToPending([P], ev("beforeSubmitPrompt", 1_002_000, { conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello" }));
    expect(m!.promptMatch).toBe(true);
  });

  test("beforeSubmitPrompt with edited prompt → edited", () => {
    const m = matchHookToPending([P], ev("beforeSubmitPrompt", 1_002_000, { conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello!" }));
    expect(m!.promptMatch).toBe("edited");
  });

  test("ignores events from other workspaces", () => {
    expect(matchHookToPending([P], ev("beforeSubmitPrompt", 1_001_000, { conversation_id: "c1", workspace_roots: ["/ws/b"], prompt: "hello" }))).toBeNull();
  });

  test("ignores events before dispatch (beyond 5s tolerance)", () => {
    expect(matchHookToPending([P], ev("beforeSubmitPrompt", 990_000, { conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello" }))).toBeNull();
  });

  test("ignores events without conversation_id", () => {
    expect(matchHookToPending([P], ev("beforeSubmitPrompt", 1_001_000, { workspace_roots: ["/ws/a"], prompt: "hello" }))).toBeNull();
  });

  test("ignores unrelated hook names", () => {
    expect(matchHookToPending([P], ev("preToolUse", 1_001_000, { conversation_id: "c1", workspace_roots: ["/ws/a"] }))).toBeNull();
  });

  test("picks latest-dispatched pending when multiple match (stale pending must not steal binding)", () => {
    const older = { ...P, runId: "r-old", dispatchedAt: 999_000 };
    const newer = { ...P, runId: "r-new", dispatchedAt: 1_000_000 };
    const m = matchHookToPending([newer, older], ev("beforeSubmitPrompt", 1_001_000, { conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello" }));
    expect(m!.run.runId).toBe("r-new");
  });

  test("captures transcript_path when present", () => {
    const m = matchHookToPending([P], ev("beforeSubmitPrompt", 1_002_000, { conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello", transcript_path: "/tmp/t.jsonl" }));
    expect(m!.transcriptPath).toBe("/tmp/t.jsonl");
  });

  test("followup pending is matchable by beforeSubmitPrompt (session reuse)", () => {
    // Executor.followup adds PendingRun after paste; child must bind without a new sessionStart.
    const child: PendingRun = {
      runId: "r-followup",
      workspaceRoot: "/ws/a",
      prompt: "继续",
      dispatchedAt: 2_000_000,
    };
    const m = matchHookToPending(
      [child],
      ev("beforeSubmitPrompt", 2_001_000, {
        conversation_id: "cid-parent",
        workspace_roots: ["/ws/a"],
        prompt: "继续",
      }),
    );
    expect(m).toMatchObject({ run: child, conversationId: "cid-parent", promptMatch: true });
  });
});

describe("conversation ownership", () => {
  test("latestRunIdForConversation picks last bound run (stop must not go to completed owner)", () => {
    const bound = new Map<string, { conversationId: string }>([
      ["r-old", { conversationId: "c1" }],
      ["r-new", { conversationId: "c1" }],
    ]);
    expect(latestRunIdForConversation(bound, "c1")).toBe("r-new");
    expect(latestRunIdForConversation(bound, "other")).toBeUndefined();
  });

  test("claimConversation evicts previous owner of the same cid", () => {
    const bound = new Map<string, { conversationId: string; prompt: string }>();
    claimConversation(bound, "r-old", "c1", "a");
    claimConversation(bound, "r-new", "c1", "b");
    expect([...bound.keys()]).toEqual(["r-new"]);
    expect(bound.get("r-new")?.prompt).toBe("b");
  });
});
