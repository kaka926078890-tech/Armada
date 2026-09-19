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
  test("same request_id later detected_at replaces plan body even if shorter", () => {
    const full = mergePendingAskRecord(short, parsePendingAsk({
      request_id: "ask-plan-1",
      kind: "plan",
      questions: [{ id: "q0", prompt: "Created Plan: Markdown date line", options: [{ id: "build", label: "Build", text: "# 完整计划\n\n步骤一" }] }],
      detected_at: 2,
      detect_via: "cdp",
    })!);
    const incoming = parsePendingAsk({
      request_id: "ask-plan-1",
      kind: "plan",
      questions: [{ id: "q0", prompt: "Created Plan: Markdown date line", options: [{ id: "build", label: "Build", text: "短" }] }],
      detected_at: 3,
      detect_via: "cdp",
    });
    const next = mergePendingAskRecord(full, incoming!);
    expect(next.questions[0].options[0].text).toBe("短");
    expect(next.detected_at).toBe(3);
  });

  test("same request_id earlier detected_at does not replace even if longer", () => {
    const incoming = parsePendingAsk({
      request_id: "ask-plan-1",
      kind: "plan",
      questions: [{ id: "q0", prompt: "Created Plan: Markdown date line", options: [{ id: "build", label: "Build", text: "# 完整计划\n\n步骤一" }] }],
      detected_at: 0,
      detect_via: "cdp",
    });
    const next = mergePendingAskRecord(short, incoming!);
    expect(next.questions[0].options[0].text).toBe("追加一行日期");
    expect(next.detected_at).toBe(1);
  });

  test("same request_id later detected_at keeps a longer plan body", () => {
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
    expect(next.detected_at).toBe(2);
  });
});
