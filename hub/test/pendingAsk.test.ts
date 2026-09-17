import { describe, expect, test } from "bun:test";
import { mergePendingAskRecord, parsePendingAsk } from "../src/pendingAsk";

const short = parsePendingAsk({
  request_id: "ask-plan-1",
  kind: "plan",
  filename: "Markdown date line",
  questions: [{ id: "q0", prompt: "Created Plan: Markdown date line", options: [{ id: "build", label: "Build", text: "追加一行日期" }] }],
  detected_at: 1,
  detect_via: "cdp",
});

describe("mergePendingAskRecord", () => {
  test("same request_id keeps a longer plan body", () => {
    const incoming = parsePendingAsk({
      request_id: "ask-plan-1",
      kind: "plan",
      filename: "Markdown date line",
      questions: [{ id: "q0", prompt: "Created Plan: Markdown date line", options: [{ id: "build", label: "Build", text: "# 完整计划\n\n步骤一" }] }],
      detected_at: 2,
      detect_via: "cdp",
    });
    const next = mergePendingAskRecord(short, incoming!);
    expect(next.questions[0].options[0].text).toContain("# 完整计划");
    expect(next.request_id).toBe("ask-plan-1");
  });

  test("same request_id does not shrink a longer body already stored", () => {
    const incoming = parsePendingAsk({
      request_id: "ask-plan-1",
      kind: "plan",
      questions: [{ id: "q0", prompt: "Created Plan: Markdown date line", options: [{ id: "build", label: "Build", text: "短" }] }],
      detected_at: 2,
      detect_via: "cdp",
    });
    const full = mergePendingAskRecord(short, parsePendingAsk({
      request_id: "ask-plan-1",
      kind: "plan",
      questions: [{ id: "q0", prompt: "Created Plan: Markdown date line", options: [{ id: "build", label: "Build", text: "# 完整计划\n\n步骤一" }] }],
      detected_at: 2,
      detect_via: "cdp",
    })!);
    expect(mergePendingAskRecord(full, incoming!).questions[0].options[0].text).toContain("# 完整计划");
  });
});
