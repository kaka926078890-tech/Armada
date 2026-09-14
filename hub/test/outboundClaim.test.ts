import { describe, expect, test } from "bun:test";
import { extractUserText, transcriptUserPrompt, hookSubmitPrompt, queueModeOf } from "../src/outboundClaim";

describe("outboundClaim", () => {
  test("extractUserText strips wrappers", () => {
    expect(extractUserText("<user_query>\n排队句\n</user_query>")).toBe("排队句");
  });
  test("transcript user only; assistant ignored", () => {
    expect(transcriptUserPrompt({
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>\n  排队句  \n</user_query>" }] },
    })).toBe("排队句");
    expect(transcriptUserPrompt({ role: "assistant", message: { content: [{ type: "text", text: "排队句" }] } })).toBeNull();
  });
  test("unknown heartbeat is not queue", () => {
    expect(queueModeOf("queue")).toBe("queue");
    expect(queueModeOf("steer")).toBe("steer");
    expect(queueModeOf("keep")).toBe("unknown");
    expect(queueModeOf(undefined)).toBe("unknown");
  });
  test("hook submit prompt normalizes", () => {
    expect(hookSubmitPrompt({ prompt: "  排队句  " })).toBe("排队句");
  });
});
