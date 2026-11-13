import { describe, expect, test } from "bun:test";
import { extractUserText, transcriptUserPrompt, statusUserPrompt, hookSubmitPrompt, operatorAlertPrompt, outboundClaimFromHook, outboundClaimKey, queueModeOf } from "../src/outboundClaim";

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
  test("alert prompt is the operator line, not a shell notice or protocol follow-up", () => {
    expect(operatorAlertPrompt("代码改在哪里？")).toBe("代码改在哪里？");
    expect(operatorAlertPrompt("<timestamp>Friday, Nov 13, 2026, 4:10 PM (UTC+8)</timestamp>\n<user_query>\n代码改在哪里？\n</user_query>")).toBe("代码改在哪里？");
    expect(operatorAlertPrompt("<timestamp>Friday, Nov 13, 2026, 4:10 PM (UTC+8)</timestamp>\n<system_notification>\nThe following task has finished.\n</system_notification>")).toBeNull();
    expect(operatorAlertPrompt("<user_query>Briefly inform the user about the task result and perform any follow-up actions.</user_query>")).toBeNull();
    expect(operatorAlertPrompt("<user_query>\n<available_subagent_types>\nx\n</available_subagent_types>\n</user_query>")).toBeNull();
  });
  test("image followup claim strips markers and keeps a caption", () => {
    expect(outboundClaimKey("[Image]\n<image_files>a.png</image_files>\n看图")).toEqual({ text: "看图", imageOnly: false });
    expect(outboundClaimFromHook({ prompt: "[Image]\n<image_files>a.png</image_files>" })).toEqual({ text: "", imageOnly: true });
    expect(outboundClaimKey("看图")).toEqual({ text: "看图", imageOnly: false });
  });

  test("statusUserPrompt ignores Cursor internal catalogs and keeps operator text", () => {
    const user = (text: string) => ({ role: "user", message: { content: [{ type: "text", text }] } });
    expect(statusUserPrompt(user("<available_subagent_types>\nAvailable subagent_types\n</available_subagent_types>"))).toBeNull();
    expect(statusUserPrompt(user("<available_subagent_models>\nAvailable models\n</available_subagent_models>"))).toBeNull();
    expect(statusUserPrompt(user("<user_query>\n打完包了再通知我\n</user_query>"))).toBe("打完包了再通知我");
    expect(statusUserPrompt(user("<user_query>\n帮我看看 available_subagent_types 是什么\n</user_query>"))).toBe("帮我看看 available_subagent_types 是什么");
    expect(statusUserPrompt(user("<user_query>Briefly inform the user about the task result.</user_query>"))).toBe("Briefly inform the user about the task result.");
    expect(statusUserPrompt({ role: "assistant", message: { content: [{ type: "text", text: "<available_subagent_types>" }] } })).toBeNull();
  });
});
