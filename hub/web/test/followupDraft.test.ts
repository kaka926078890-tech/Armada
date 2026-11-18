import { describe, expect, test } from "bun:test";
import { rejectedFollowupDraft, settleFollowupComposer, type FollowupDraftEvent } from "../src/followupDraft";

function ev(partial: Partial<FollowupDraftEvent> & { seq: number; payload: string }): FollowupDraftEvent {
  return { hook_event_name: null, ...partial };
}

const rejected = (seq: number, prompt = "看 sha abc123") => ev({
  seq,
  hook_event_name: "followupRejected",
  payload: JSON.stringify({
    text: "续聊没有发出去。文件菜单对上了不止一条，这一轮没有提交。",
    reason: "MENTION_CLICK:AMBIGUOUS",
    prompt,
  }),
});

describe("rejectedFollowupDraft", () => {
  test("keeps the prompt from the latest rejection", () => {
    expect(rejectedFollowupDraft([
      ev({ seq: 1, hook_event_name: "afterAgentResponse", payload: JSON.stringify({ text: "上一轮" }) }),
      rejected(2),
    ])).toEqual({ seq: 2, prompt: "看 sha abc123" });
  });

  test("a later submitted user line means the draft was sent", () => {
    expect(rejectedFollowupDraft([
      rejected(2),
      ev({ seq: 3, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "看 sha abc123" }) }),
    ])).toBeNull();
  });

  test("a transcript user line after the rejection also supersedes it", () => {
    expect(rejectedFollowupDraft([
      rejected(2),
      ev({ seq: 3, source: "transcript", payload: JSON.stringify({ role: "user", message: { content: [] } }) }),
    ])).toBeNull();
  });

  test("a rejection without the original prompt cannot be restored", () => {
    expect(rejectedFollowupDraft([
      ev({ seq: 2, hook_event_name: "followupRejected", payload: JSON.stringify({ text: "续聊没有发出去。", reason: "REJECTED" }) }),
    ])).toBeNull();
  });
});

describe("settleFollowupComposer", () => {
  const base = {
    awaiting: true,
    sawDispatched: false,
    sent: "看 sha abc123",
    draft: "看 sha abc123",
    afterSeq: 5,
    events: [] as FollowupDraftEvent[],
  };

  test("clears the text as soon as the hub accepts, before inject finishes", () => {
    expect(settleFollowupComposer({ ...base, status: "dispatched" })).toEqual({
      awaiting: true,
      sawDispatched: true,
      draft: "",
      clearFiles: false,
    });
  });

  test("a cleared box stays empty while inject is still in flight", () => {
    expect(settleFollowupComposer({
      ...base,
      draft: "",
      sawDispatched: true,
      status: "dispatched",
    })).toEqual({
      awaiting: true,
      sawDispatched: true,
      draft: "",
      clearFiles: false,
    });
  });

  test("an edit typed while inject is in flight is not wiped", () => {
    expect(settleFollowupComposer({
      ...base,
      draft: "看 sha abc123，再补一句",
      status: "dispatched",
    })).toMatchObject({ awaiting: true, draft: "看 sha abc123，再补一句", clearFiles: false });
  });

  test("an older error status does not drop the draft before dispatch is seen", () => {
    expect(settleFollowupComposer({ ...base, status: "error" }).awaiting).toBe(true);
    expect(settleFollowupComposer({ ...base, status: "error" }).draft).toBe("看 sha abc123");
  });

  test("rejection keeps the draft and the files", () => {
    expect(settleFollowupComposer({
      ...base,
      sawDispatched: true,
      status: "error",
      events: [rejected(6)],
    })).toEqual({
      awaiting: false,
      sawDispatched: true,
      draft: "看 sha abc123",
      clearFiles: false,
    });
  });

  test("rejection after the box was cleared puts the sent text back", () => {
    expect(settleFollowupComposer({
      ...base,
      draft: "",
      sawDispatched: true,
      status: "error",
      events: [rejected(6)],
    })).toEqual({
      awaiting: false,
      sawDispatched: true,
      draft: "看 sha abc123",
      clearFiles: false,
    });
  });

  test("an accepted follow-up clears the draft", () => {
    expect(settleFollowupComposer({
      ...base,
      sawDispatched: true,
      status: "binding",
      events: [ev({ seq: 6, hook_event_name: "beforeSubmitPrompt", payload: JSON.stringify({ prompt: "看 sha abc123" }) })],
    })).toEqual({
      awaiting: false,
      sawDispatched: true,
      draft: "",
      clearFiles: true,
    });
  });

  test("a failed live outbound keeps the draft", () => {
    expect(settleFollowupComposer({
      ...base,
      status: "running",
      outbound: [{ prompt: "看 sha abc123", state: "failed", created_at: 9 }],
    })).toMatchObject({ awaiting: false, draft: "看 sha abc123", clearFiles: false });
  });

  test("surrounding space still counts as the sent text and clears", () => {
    expect(settleFollowupComposer({
      ...base,
      draft: "看 sha abc123\n",
      sawDispatched: true,
      status: "completed",
    })).toMatchObject({ awaiting: false, draft: "", clearFiles: true });
  });

  test("an edit made while inject is in flight stays after accept", () => {
    expect(settleFollowupComposer({
      ...base,
      draft: "看 sha abc123，再补一句",
      sawDispatched: true,
      status: "binding",
    })).toMatchObject({ awaiting: false, draft: "看 sha abc123，再补一句", clearFiles: false });
  });

  test("a queued live outbound clears the draft", () => {
    expect(settleFollowupComposer({
      ...base,
      status: "running",
      outbound: [{ prompt: "看 sha abc123", state: "queued", created_at: 9 }],
    })).toMatchObject({ awaiting: false, draft: "", clearFiles: true });
  });

  test("a live outbound still injecting clears the text and keeps the files", () => {
    expect(settleFollowupComposer({
      ...base,
      status: "running",
      outbound: [{ prompt: "看 sha abc123", state: "injecting", created_at: 9 }],
    })).toEqual({
      awaiting: true,
      sawDispatched: false,
      draft: "",
      clearFiles: false,
    });
  });

  test("after the box is cleared, a queued outbound still drops the files", () => {
    expect(settleFollowupComposer({
      ...base,
      draft: "",
      status: "running",
      outbound: [{ prompt: "看 sha abc123", state: "queued", created_at: 9 }],
    })).toMatchObject({ awaiting: false, draft: "", clearFiles: true });
  });

  test("a failed live outbound restores text that was already cleared", () => {
    expect(settleFollowupComposer({
      ...base,
      draft: "",
      status: "running",
      outbound: [{ prompt: "看 sha abc123", state: "failed", created_at: 9 }],
    })).toMatchObject({ awaiting: false, draft: "看 sha abc123", clearFiles: false });
  });
});
