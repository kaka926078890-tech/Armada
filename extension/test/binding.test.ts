import { describe, expect, test } from "bun:test";
import { matchHookToPending, type PendingRun } from "../src/binding";

const P: PendingRun = { runId: "r-1", workspaceRoot: "/ws/a", prompt: "hello", dispatchedAt: 1_000_000 };

function ev(hook: string, tsMs: number, raw: any) {
  return { hook, ts: tsMs / 1000, raw };
}

describe("matchHookToPending", () => {
  test("sessionStart in workspace after dispatch binds with promptMatch=false", () => {
    const m = matchHookToPending([P], ev("sessionStart", 1_001_000, { conversation_id: "c1", workspace_roots: ["/ws/a"] }));
    expect(m).toMatchObject({ run: P, conversationId: "c1", promptMatch: false });
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
    expect(matchHookToPending([P], ev("sessionStart", 1_001_000, { conversation_id: "c1", workspace_roots: ["/ws/b"] }))).toBeNull();
  });

  test("ignores events before dispatch (beyond 5s tolerance)", () => {
    expect(matchHookToPending([P], ev("sessionStart", 990_000, { conversation_id: "c1", workspace_roots: ["/ws/a"] }))).toBeNull();
  });

  test("ignores events without conversation_id", () => {
    expect(matchHookToPending([P], ev("sessionStart", 1_001_000, { workspace_roots: ["/ws/a"] }))).toBeNull();
  });

  test("ignores unrelated hook names", () => {
    expect(matchHookToPending([P], ev("preToolUse", 1_001_000, { conversation_id: "c1", workspace_roots: ["/ws/a"] }))).toBeNull();
  });

  test("picks earliest-dispatched pending when multiple match", () => {
    const older = { ...P, runId: "r-old", dispatchedAt: 999_000 };
    const newer = { ...P, runId: "r-new", dispatchedAt: 1_000_000 };
    const m = matchHookToPending([newer, older], ev("sessionStart", 1_001_000, { conversation_id: "c1", workspace_roots: ["/ws/a"] }));
    expect(m!.run.runId).toBe("r-old");
  });

  test("captures transcript_path when present", () => {
    const m = matchHookToPending([P], ev("beforeSubmitPrompt", 1_002_000, { conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello", transcript_path: "/tmp/t.jsonl" }));
    expect(m!.transcriptPath).toBe("/tmp/t.jsonl");
  });
});
