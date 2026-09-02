import { describe, expect, test } from "bun:test";
import { matchHookToPending, latestRunIdForConversation, claimConversation, eventBelongsToWindow, transcriptPathBelongsToCid, runIdForHook, rememberSubagent, isAmbiguousMatch, dropPendingRuns, type PendingRun } from "../src/binding";

const P: PendingRun = { runId: "r-1", workspaceRoot: "/ws/a", prompt: "hello", dispatchedAt: 1_000_000 };

function ev(hook: string, tsMs: number, raw: any) {
  return { hook, ts: tsMs / 1000, raw };
}

describe("matchHookToPending", () => {
  test("sessionStart never binds (fires at chat creation, before submit)", () => {
    expect(matchHookToPending([P], ev("sessionStart", 1_001_000, { conversation_id: "c1", workspace_roots: ["/ws/a"] }))).toBeNull();
  });

  test("image-only hook binds unique pending with attachments", () => {
    const img = { ...P, prompt: "", attachmentIds: ["abc"] };
    const m = matchHookToPending([img], ev("beforeSubmitPrompt", 1_002_000, {
      conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "[Image]\n<image_files>x.png</image_files>",
    }));
    expect(m && "run" in m ? m.run.runId : null).toBe("r-1");
  });

  test("two image-only pendings with the same hook are ambiguous", () => {
    const a = { ...P, runId: "r-a", prompt: "", attachmentIds: ["a"] };
    const b = { ...P, runId: "r-b", prompt: "", attachmentIds: ["b"], dispatchedAt: 999_000 };
    const m = matchHookToPending([a, b], ev("beforeSubmitPrompt", 1_002_000, {
      conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "[Image]\n<image_files>x.png</image_files>",
    }));
    expect(isAmbiguousMatch(m)).toBe(true);
  });

  test("beforeSubmitPrompt with same prompt → true", () => {
    const m = matchHookToPending([P], ev("beforeSubmitPrompt", 1_002_000, { conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello" }));
    expect(m!.promptMatch).toBe(true);
  });

  test("beforeSubmitPrompt with a different prompt does not bind", () => {
    expect(matchHookToPending([P], ev("beforeSubmitPrompt", 1_002_000, {
      conversation_id: "c-other", workspace_roots: ["/ws/a"], prompt: "样式优化一下",
    }))).toBeNull();
  });

  test("garbled ??? prompt binds the only waiting run as edited", () => {
    const m = matchHookToPending([P], ev("beforeSubmitPrompt", 1_002_000, {
      conversation_id: "c-other", workspace_roots: ["/ws/a"], prompt: "???",
    }));
    expect(m?.promptMatch).toBe("edited");
    expect(m && "run" in m ? m.run.runId : null).toBe("r-1");
  });

  test("garbled ??? with two waiting runs does not guess", () => {
    const a = { ...P, runId: "r-a", prompt: "你好" };
    const b = { ...P, runId: "r-b", prompt: "样式优化一下", dispatchedAt: 999_000 };
    expect(matchHookToPending([a, b], ev("beforeSubmitPrompt", 1_002_000, {
      conversation_id: "c-x", workspace_roots: ["/ws/a"], prompt: "???",
    }))).toBeNull();
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

  test("afterSubmitPrompt does not bind (no prompt to align)", () => {
    expect(matchHookToPending([P], ev("afterSubmitPrompt", 1_002_000, { conversation_id: "c1", workspace_roots: ["/ws/a"] }))).toBeNull();
  });

  test("eventBelongsToWindow matches open folders", () => {
    expect(eventBelongsToWindow({ workspace_roots: ["/ws/a"] }, ["/ws/a"])).toBe(true);
    expect(eventBelongsToWindow({ workspace_roots: ["/ws/a"] }, ["/ws/b"])).toBe(false);
    expect(eventBelongsToWindow({}, ["/ws/a"])).toBe(false);
  });

  test("eventBelongsToWindow treats Windows slash and drive-letter case as the same workspace", () => {
    expect(eventBelongsToWindow(
      { workspace_roots: ["C:\\Users\\PC\\Desktop\\work"] },
      ["c:\\Users\\PC\\Desktop\\work"],
    )).toBe(true);
    expect(eventBelongsToWindow(
      { workspace_roots: ["c:/Users/PC/Desktop/work"] },
      ["c:\\Users\\PC\\Desktop\\work"],
    )).toBe(true);
    expect(eventBelongsToWindow(
      { workspace_roots: ["/c/Users/PC/Desktop/work"] },
      ["c:\\Users\\PC\\Desktop\\work"],
    )).toBe(true);
    expect(eventBelongsToWindow(
      { workspace_roots: ["/C:/Users/PC/Desktop/work"] },
      ["c:\\Users\\PC\\Desktop\\work"],
    )).toBe(true);
  });


  test("matchHookToPending binds when hook roots use Windows path variants", () => {
    const win = { ...P, workspaceRoot: "c:\\Users\\PC\\Desktop\\work" };
    const m = matchHookToPending([win], ev("beforeSubmitPrompt", 1_002_000, {
      conversation_id: "c1",
      workspace_roots: ["C:/Users/PC/Desktop/work"],
      prompt: "hello",
    }));
    expect(m?.run.runId).toBe("r-1");
  });

  test("two pending with the same prompt do not bind (no FIFO guess)", () => {
    const older = { ...P, runId: "r-old", dispatchedAt: 999_000 };
    const newer = { ...P, runId: "r-new", dispatchedAt: 1_000_000 };
    const m = matchHookToPending([newer, older], ev("beforeSubmitPrompt", 1_001_000, {
      conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello",
    }));
    expect(m).toMatchObject({ ambiguous: true });
    if (m && "ambiguous" in m) {
      expect(m.runs.map((r) => r.runId).sort()).toEqual(["r-new", "r-old"]);
    }
  });

  test("two pending with different prompts bind the matching one", () => {
    const a = { ...P, runId: "r-a", prompt: "task a", dispatchedAt: 1_000_000 };
    const b = { ...P, runId: "r-b", prompt: "task b", dispatchedAt: 999_000 };
    const m = matchHookToPending([a, b], ev("beforeSubmitPrompt", 1_001_000, {
      conversation_id: "c-b", workspace_roots: ["/ws/a"], prompt: "task b",
    }));
    expect(m && "run" in m ? m.run.runId : undefined).toBe("r-b");
  });

  test("normalized whitespace still binds the matching pending", () => {
    const run = { ...P, prompt: "hello  world" };
    const m = matchHookToPending([run], ev("beforeSubmitPrompt", 1_002_000, {
      conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "  hello\r\n  world  ",
    }));
    expect(m && "run" in m ? m.run.runId : undefined).toBe("r-1");
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

describe("ambiguous pending handling", () => {
  test("isAmbiguousMatch is true only for the ambiguous result", () => {
    const older = { ...P, runId: "r-old", dispatchedAt: 999_000 };
    const newer = { ...P, runId: "r-new", dispatchedAt: 1_000_000 };
    const amb = matchHookToPending([newer, older], ev("beforeSubmitPrompt", 1_001_000, {
      conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello",
    }));
    expect(isAmbiguousMatch(amb)).toBe(true);
    expect(isAmbiguousMatch(null)).toBe(false);
    const hit = matchHookToPending([P], ev("beforeSubmitPrompt", 1_002_000, {
      conversation_id: "c1", workspace_roots: ["/ws/a"], prompt: "hello",
    }));
    expect(isAmbiguousMatch(hit)).toBe(false);
  });

  test("dropPendingRuns removes the ambiguous ids from pending", () => {
    const older = { ...P, runId: "r-old", dispatchedAt: 999_000 };
    const newer = { ...P, runId: "r-new", dispatchedAt: 1_000_000 };
    const keep = { ...P, runId: "r-keep", prompt: "other" };
    const pending = [newer, older, keep];
    dropPendingRuns(pending, [newer, older]);
    expect(pending.map((p) => p.runId)).toEqual(["r-keep"]);
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

  test("runIdForHook does not attribute another conversation to the bound run", () => {
    const bound = new Map<string, { conversationId: string }>([["r-1", { conversationId: "c-hello" }]]);
    const children = new Map<string, string>();
    expect(runIdForHook(bound, children, "c-hello")).toBe("r-1");
    expect(runIdForHook(bound, children, "c-debug")).toBeUndefined();
  });

  test("rememberSubagent maps child cid to the parent run", () => {
    const bound = new Map<string, { conversationId: string }>([["r-1", { conversationId: "c-hello" }]]);
    const children = new Map<string, string>();
    rememberSubagent(children, bound, "subagentStart", {
      conversation_id: "c-child", parent_conversation_id: "c-hello",
    });
    expect(runIdForHook(bound, children, "c-child")).toBe("r-1");
  });

  test("transcriptPathBelongsToCid accepts matching jsonl and rejects a sibling conversation", () => {
    const hello = "f53d9969-0734-48a9-9864-a5ab0702e00e";
    const debug = "704d5468-2e6c-4ecf-bca4-4d1ae16c264e";
    const p = `/Users/apple/.cursor/projects/desk/agent-transcripts/${hello}/${hello}.jsonl`;
    expect(transcriptPathBelongsToCid(p, hello)).toBe(true);
    expect(transcriptPathBelongsToCid(p, debug)).toBe(false);
    expect(transcriptPathBelongsToCid(
      `/Users/apple/.cursor/projects/desk/agent-transcripts/${hello}/subagents/child.jsonl`,
      hello,
    )).toBe(true);
  });
});
