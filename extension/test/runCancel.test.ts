import { describe, expect, test } from "bun:test";
import { askPollMany } from "../src/askDetect";
import { noteRunReopened } from "../src/runCancel";

/** r-ac71f2e4: cancel at 15:29, Questions still on screen at 15:43, no askQuestion in the extension log. */
const RUN = "r-ac71f2e4-0694-4bb4-951b-6a18fdad7328";
const CID = "271cf102-6877-48be-8f06-7b09a870dbc3";

const questions = {
  present: true as const,
  conversation_id: CID,
  prompt: "v1 第一批先上哪些?",
  options: [
    { id: "a", label: "A", text: "先上 M 和 P1，P2 单独再上" },
    { id: "d", label: "D", text: "区别是什么?" },
  ],
  questions: [{
    id: "q0",
    prompt: "v1 第一批先上哪些?",
    options: [
      { id: "a", label: "A", text: "先上 M 和 P1，P2 单独再上" },
      { id: "d", label: "D", text: "区别是什么?" },
    ],
  }],
};

describe("cancel latch vs a later questionnaire", () => {
  test("a cancelled card drops the on-screen Questions; reopening the same run emits askQuestion", () => {
    const cancelled = new Set([RUN]);
    const bound = new Map([[RUN, { conversationId: CID }]]);
    const hidden = askPollMany(bound, [], [questions], [], () => "ask-1", 1, [], [], cancelled);
    expect(hidden.filter((a) => a.type === "askQuestion")).toEqual([]);

    noteRunReopened(cancelled, RUN);
    const shown = askPollMany(bound, [], [questions], [], () => "ask-2", 2, [], [], cancelled);
    expect(shown).toEqual([
      expect.objectContaining({ type: "askQuestion", runId: RUN }),
    ]);
  });
});
