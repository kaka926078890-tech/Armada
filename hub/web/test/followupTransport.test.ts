import { describe, expect, test } from "bun:test";
import { followupLandedAfterTransportError, isFollowupTransportError } from "../src/followupTransport";

describe("isFollowupTransportError", () => {
  test("matches the WKWebView fetch failure", () => {
    expect(isFollowupTransportError(new TypeError("Load failed"))).toBe(true);
  });

  test("matches Chromium's fetch failure", () => {
    expect(isFollowupTransportError(new TypeError("Failed to fetch"))).toBe(true);
  });

  test("leaves hub error codes alone", () => {
    expect(isFollowupTransportError(new Error("CONVERSATION_BUSY"))).toBe(false);
  });
});

describe("followupLandedAfterTransportError", () => {
  const prompt = "帮忙看看AC分支的开发进度";

  test("an idle followup reopened the card", () => {
    expect(followupLandedAfterTransportError({
      prompt,
      sentAt: 2_000,
      before: { startedAt: 1_000 },
      after: { startedAt: 2_050 },
    })).toBe(true);
  });

  test("a lost response on an untouched card did not land", () => {
    expect(followupLandedAfterTransportError({
      prompt,
      sentAt: 5_000,
      before: { startedAt: 1_000 },
      after: { startedAt: 1_000 },
    })).toBe(false);
  });

  test("a live followup is the new outbound row", () => {
    expect(followupLandedAfterTransportError({
      prompt,
      sentAt: 5_000,
      before: { startedAt: 1_000 },
      after: {
        startedAt: 1_000,
        outbound: [{ prompt, state: "injecting", created_at: 5_010 }],
      },
    })).toBe(true);
  });

  test("a failed outbound is not a successful send", () => {
    expect(followupLandedAfterTransportError({
      prompt,
      sentAt: 5_000,
      before: { startedAt: 1_000 },
      after: {
        startedAt: 1_000,
        outbound: [{ prompt, state: "failed", created_at: 5_010 }],
      },
    })).toBe(false);
  });
});
