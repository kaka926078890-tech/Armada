import { describe, expect, test } from "bun:test";
import { noteOwnerBsp, clearGeneration, synthesizedStopPayload, noteHubGeneration, onFollowupBindGeneration, shouldSynthesizeTranscriptStop } from "../src/generationStamp";

describe("generationStamp", () => {
  test("only owner beforeSubmitPrompt stores gen", () => {
    const m = new Map<string, string>();
    noteOwnerBsp(m, "r1", "afterAgentResponse", { generation_id: "g1", conversation_id: "c1" }, "c1");
    expect(m.size).toBe(0);
    noteOwnerBsp(m, "r1", "beforeSubmitPrompt", { generation_id: "g1", conversation_id: "c1" }, "c1");
    expect(m.get("r1")).toBe("g1");
    noteOwnerBsp(m, "r1", "beforeSubmitPrompt", { generation_id: "c1", conversation_id: "c1" }, "c1");
    expect(m.get("r1")).toBe("g1");
  });
  test("no lastGenerationId refuses synthesize; followup clear refuses", () => {
    expect(synthesizedStopPayload({ status: "completed" }, undefined, "c1").ok).toBe(false);
    const m = new Map([["r1", "g1"]]);
    clearGeneration(m, "r1");
    expect(synthesizedStopPayload({ status: "completed" }, m.get("r1"), "c1").ok).toBe(false);
  });
  test("followup bind keeps hub-issued gen so Windows synth stop can complete", () => {
    // Real shape (Win Desktop 打完了给我说一声): run.followup notes hub gen, then
    // applyBinding(fromEnd) used to clearGeneration and refuse synth stop → 运行中.
    const m = new Map<string, string>();
    noteHubGeneration(m, "r1", "g-old");
    noteHubGeneration(m, "r1", "hub-follow");
    onFollowupBindGeneration(m, "r1");
    expect(synthesizedStopPayload({ status: "completed" }, m.get("r1"), "c1")).toEqual({
      ok: true,
      payload: { status: "completed", generation_id: "hub-follow", conversation_id: "c1" },
    });
  });
  test("hub-issued generation is stored for synthesized stop", () => {
    const m = new Map<string, string>();
    noteHubGeneration(m, "r1", "hub-g1");
    expect(m.get("r1")).toBe("hub-g1");
    noteHubGeneration(m, "r1", "");
    expect(m.get("r1")).toBe("hub-g1");
    const r = synthesizedStopPayload({ status: "completed" }, m.get("r1"), "c1");
    expect(r).toEqual({ ok: true, payload: { status: "completed", generation_id: "hub-g1", conversation_id: "c1" } });
  });
  test("run.generation uses the same stamp; missing lastGenerationId still refuses synth (E2)", () => {
    const m = new Map<string, string>();
    noteHubGeneration(m, "r1", "g2-from-ws");
    expect(m.get("r1")).toBe("g2-from-ws");
    expect(synthesizedStopPayload({ status: "completed" }, undefined, "c1").ok).toBe(false);
  });
  test("stamps generation_id and conversation_id", () => {
    const r = synthesizedStopPayload({ status: "completed" }, "g1", "c1");
    expect(r).toEqual({ ok: true, payload: { status: "completed", generation_id: "g1", conversation_id: "c1" } });
  });
  test("jsonl turn_ended is synthesized on darwin and win32 (hooks can miss after a finished composer turn)", () => {
    expect(shouldSynthesizeTranscriptStop("darwin")).toBe(true);
    expect(shouldSynthesizeTranscriptStop("darwin-arm64")).toBe(true);
    expect(shouldSynthesizeTranscriptStop("win32")).toBe(true);
    expect(shouldSynthesizeTranscriptStop("linux")).toBe(true);
  });

  // r-5fb47426 14:40–14:43 (cid fc0d2224): parent BSP b855863b drained on
  // open child jsonl; Cursor protocol-resumed with UUID preToolUse 02037258
  // then b89b8455. jsonl turn_ended synth still stamped the retired BSP gen
  // → hub STOP_GEN_RETIRED, card stuck 运行中.
  test("owner-cid UUID preToolUse updates stamp so synth stop covers live gen", () => {
    const G1 = "b855863b-cbb8-4c00-a0ba-23b6c69ddcf0";
    const G2 = "02037258-5b49-44c1-9d40-30205dc9d3c4";
    const G3 = "b89b8455-84de-4c1c-823d-4aeba602fdee";
    const sidecar = "b89b8455-84de-4c1c-823d-4aeba602fdee-4-1092";
    const cid = "fc0d2224-cecb-40ce-a6a8-c1a486344c3b";
    const m = new Map<string, string>();
    noteOwnerBsp(m, "r1", "beforeSubmitPrompt", { generation_id: G1, conversation_id: cid }, cid);
    noteOwnerBsp(m, "r1", "afterAgentThought", { generation_id: G2, conversation_id: cid }, cid);
    expect(m.get("r1")).toBe(G1);
    noteOwnerBsp(m, "r1", "preToolUse", { generation_id: G2, conversation_id: cid }, cid);
    expect(m.get("r1")).toBe(G2);
    noteOwnerBsp(m, "r1", "preToolUse", { generation_id: sidecar, conversation_id: cid }, cid);
    expect(m.get("r1")).toBe(G2);
    noteOwnerBsp(m, "r1", "preToolUse", { generation_id: G3, conversation_id: cid }, cid);
    expect(synthesizedStopPayload({ status: "completed" }, m.get("r1"), cid)).toEqual({
      ok: true,
      payload: { status: "completed", generation_id: G3, conversation_id: cid },
    });
    noteOwnerBsp(m, "r1", "preToolUse", { generation_id: G1, conversation_id: cid }, cid);
    expect(m.get("r1")).toBe(G3);
  });
});
