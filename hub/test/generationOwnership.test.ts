import { describe, expect, test } from "bun:test";
import { parseRetiredIds, appendRetired, decideArm, decideStop, isWindowsMachineOs } from "../src/generationOwnership";

const CID = "cid-1";
const G = "gen-new";
const GOLD = "gen-old";

describe("isWindowsMachineOs", () => {
  test("win32 prefix only", () => {
    expect(isWindowsMachineOs("win32")).toBe(true);
    expect(isWindowsMachineOs("win32-x64")).toBe(true);
    expect(isWindowsMachineOs("darwin-arm64")).toBe(false);
    expect(isWindowsMachineOs("linux-x64")).toBe(false);
    expect(isWindowsMachineOs(undefined)).toBe(false);
  });
});

describe("parseRetiredIds", () => {
  test("parses array; garbage becomes empty and parseFailed", () => {
    expect(parseRetiredIds('["a"]')).toEqual({ ids: ["a"], parseFailed: false });
    expect(parseRetiredIds("not-json").parseFailed).toBe(true);
    expect(parseRetiredIds("not-json").ids).toEqual([]);
    expect(parseRetiredIds(null).ids).toEqual([]);
  });
});

describe("appendRetired", () => {
  test("skips empty; FIFO cap 32", () => {
    expect(appendRetired([], null)).toEqual([]);
    expect(appendRetired(["a"], "b")).toEqual(["a", "b"]);
    const many = Array.from({ length: 32 }, (_, i) => String(i));
    expect(appendRetired(many, "x")).toEqual([...many.slice(1), "x"]);
  });
});

describe("decideArm", () => {
  const base = {
    hookEventName: "beforeSubmitPrompt",
    generationId: G,
    eventCid: CID,
    runConversationId: CID,
    liveGenerationId: null as string | null,
    retired: [] as string[],
  };
  test("arms owner BSP", () => {
    expect(decideArm(base)).toEqual({ action: "arm", gen: G });
  });
  test("skips non-BSP, missing gen, cid mismatch, gen===cid, retired", () => {
    expect(decideArm({ ...base, hookEventName: "afterAgentResponse" }).action).toBe("skip");
    expect(decideArm({ ...base, generationId: "" }).action).toBe("skip");
    expect(decideArm({ ...base, eventCid: "other" }).action).toBe("skip");
    expect(decideArm({ ...base, generationId: CID }).action).toBe("skip");
    expect(decideArm({ ...base, retired: [G] }).action).toBe("skip");
  });
  test("same live gen is skip already_armed_same (idempotent, no overwrite needed)", () => {
    const d = decideArm({ ...base, liveGenerationId: G });
    expect(d.action).toBe("skip");
    expect(d).toMatchObject({ reason: "already_armed_same" });
  });
  test("new owner BSP while armed rearms and retires the stale live gen", () => {
    expect(decideArm({ ...base, liveGenerationId: GOLD })).toEqual({
      action: "rearm", gen: G, retire: GOLD,
    });
  });

  // r-43b92cc0 17:05:25: protocol resume has no BSP. UUID preToolUse rearms;
  // afterAgentThought and sidecar suffix gens must not.
  const G2 = "012de2b6-ebc5-4846-b36b-17c0f54b82df";
  const G1 = "6da7b38e-c959-461a-bb2d-b97197179771";
  const SIDECAR = "012de2b6-ebc5-4846-b36b-17c0f54b82df-0-6k9b";
  const resume = {
    ...base,
    generationId: G2,
    liveGenerationId: G1,
  };
  test("owner-cid UUID preToolUse rearms and retires the drained parent gen", () => {
    expect(decideArm({ ...resume, hookEventName: "preToolUse" })).toEqual({
      action: "rearm", gen: G2, retire: G1,
    });
  });
  test("afterAgentThought does not arm, even with a UUID gen", () => {
    const d = decideArm({ ...resume, hookEventName: "afterAgentThought" });
    expect(d.action).toBe("skip");
  });
  test("sidecar suffix preToolUse does not rearm (r-43b92cc0 -0-6k9b)", () => {
    const d = decideArm({
      ...resume, hookEventName: "preToolUse", generationId: SIDECAR,
    });
    expect(d.action).toBe("skip");
    expect(d).toMatchObject({ reason: "sidecar_gen" });
  });
});

describe("decideStop", () => {
  const base = {
    stopCid: CID,
    runConversationId: CID,
    stopGenerationId: G,
    liveGenerationId: G as string | null,
    hasHubFollowup: false,
    retired: [] as string[],
  };
  test("matching gen applies", () => {
    expect(decideStop(base)).toEqual({ action: "apply" });
  });
  test("child cid ignored; retired; mismatch; unarmed; no-gen after followup; initial gen-less applies", () => {
    expect(decideStop({ ...base, stopCid: "child" })).toEqual({ action: "ignore", audit: "STOP_CID_MISMATCH" });
    expect(decideStop({ ...base, retired: [G] })).toEqual({ action: "ignore", audit: "STOP_GEN_RETIRED" });
    expect(decideStop({ ...base, liveGenerationId: GOLD })).toEqual({ action: "ignore", audit: "STOP_GEN_MISMATCH" });
    expect(decideStop({ ...base, liveGenerationId: null })).toEqual({ action: "ignore", audit: "STOP_UNARMED" });
    expect(decideStop({ ...base, stopGenerationId: null, liveGenerationId: G })).toEqual({ action: "ignore", audit: "STOP_NO_GEN" });
    expect(decideStop({ ...base, stopGenerationId: null, liveGenerationId: null, hasHubFollowup: true }))
      .toEqual({ action: "ignore", audit: "STOP_NO_GEN" });
    expect(decideStop({ ...base, stopGenerationId: null, liveGenerationId: null, hasHubFollowup: false }))
      .toEqual({ action: "apply", audit: "STOP_NO_GEN_INITIAL" });
  });
  test("missing stop cid still can apply (Windows synth)", () => {
    expect(decideStop({ ...base, stopCid: undefined })).toEqual({ action: "apply" });
  });
  test("Cursor 3.18 session stop uses a sidecar gen; apply only after live turn settled", () => {
    // Real 17:43: AAR c65e24cc then stop 6ff69bf9 same cid — composer never emits its own stop.
    const sidecar = { ...base, stopGenerationId: "6ff69bf9-237c-45c6-a7fb-a77b554fb0cb", liveGenerationId: G };
    expect(decideStop(sidecar)).toEqual({ action: "ignore", audit: "STOP_GEN_MISMATCH" });
    expect(decideStop({ ...sidecar, liveTurnSettled: true })).toEqual({ action: "apply", audit: "STOP_SESSION_GEN" });
    expect(decideStop({ ...sidecar, liveTurnSettled: true, retired: ["6ff69bf9-237c-45c6-a7fb-a77b554fb0cb"] }))
      .toEqual({ action: "ignore", audit: "STOP_GEN_RETIRED" });
  });
  test("queued outstanding turns matching completed into QUEUE_DRAIN, including STOP_SESSION_GEN", () => {
    expect(decideStop({ ...base, hasOutstandingOutbound: true }))
      .toEqual({ action: "ignore", audit: "QUEUE_DRAIN" });
    const sidecar = { ...base, stopGenerationId: "6ff69bf9-237c-45c6-a7fb-a77b554fb0cb", liveGenerationId: G };
    expect(decideStop({ ...sidecar, liveTurnSettled: true, hasOutstandingOutbound: true }))
      .toEqual({ action: "ignore", audit: "QUEUE_DRAIN" });
  });
  test("outstanding does not rewrite ignores; missing flag keeps apply", () => {
    expect(decideStop({ ...base, liveGenerationId: GOLD, hasOutstandingOutbound: true }))
      .toEqual({ action: "ignore", audit: "STOP_GEN_MISMATCH" });
    expect(decideStop({ ...base, hasOutstandingOutbound: false })).toEqual({ action: "apply" });
    expect(decideStop(base)).toEqual({ action: "apply" });
  });
  test("queued outstanding does not block aborted or error", () => {
    expect(decideStop({ ...base, hasOutstandingOutbound: true, stopStatus: "aborted" })).toEqual({ action: "apply" });
    expect(decideStop({ ...base, hasOutstandingOutbound: true, stopStatus: "error" })).toEqual({ action: "apply" });
    expect(decideStop({ ...base, hasOutstandingOutbound: true, stopStatus: "completed" }))
      .toEqual({ action: "ignore", audit: "QUEUE_DRAIN" });
  });
  test("open child jsonl turns matching completed into BG_DRAIN, including STOP_SESSION_GEN", () => {
    expect(decideStop({ ...base, hasOutstandingBackground: true }))
      .toEqual({ action: "ignore", audit: "BG_DRAIN" });
    const sidecar = { ...base, stopGenerationId: "6ff69bf9-237c-45c6-a7fb-a77b554fb0cb", liveGenerationId: G };
    expect(decideStop({ ...sidecar, liveTurnSettled: true, hasOutstandingBackground: true }))
      .toEqual({ action: "ignore", audit: "BG_DRAIN" });
  });
  test("open child jsonl does not block aborted or error", () => {
    expect(decideStop({ ...base, hasOutstandingBackground: true, stopStatus: "aborted" })).toEqual({ action: "apply" });
    expect(decideStop({ ...base, hasOutstandingBackground: true, stopStatus: "error" })).toEqual({ action: "apply" });
  });
});
