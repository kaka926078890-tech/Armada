import { describe, expect, test } from "bun:test";
import { noteOwnerBsp, clearGeneration, synthesizedStopPayload } from "../src/generationStamp";

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
  test("stamps generation_id and conversation_id", () => {
    const r = synthesizedStopPayload({ status: "completed" }, "g1", "c1");
    expect(r).toEqual({ ok: true, payload: { status: "completed", generation_id: "g1", conversation_id: "c1" } });
  });
});
