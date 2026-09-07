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
});
