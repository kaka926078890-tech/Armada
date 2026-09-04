import { describe, expect, test } from "bun:test";
import { parseRetiredIds, appendRetired, decideArm, decideStop } from "../src/generationOwnership";

const CID = "cid-1";
const G = "gen-new";
const GOLD = "gen-old";

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
  test("skips non-BSP, missing gen, cid mismatch, gen===cid, retired, already_armed", () => {
    expect(decideArm({ ...base, hookEventName: "afterAgentResponse" }).action).toBe("skip");
    expect(decideArm({ ...base, generationId: "" }).action).toBe("skip");
    expect(decideArm({ ...base, eventCid: "other" }).action).toBe("skip");
    expect(decideArm({ ...base, generationId: CID }).action).toBe("skip");
    expect(decideArm({ ...base, retired: [G] }).action).toBe("skip");
    expect(decideArm({ ...base, liveGenerationId: GOLD }).action).toBe("skip");
  });
  test("same live gen is skip already_armed_same (idempotent, no overwrite needed)", () => {
    const d = decideArm({ ...base, liveGenerationId: G });
    expect(d.action).toBe("skip");
    expect(d).toMatchObject({ reason: "already_armed_same" });
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
});
