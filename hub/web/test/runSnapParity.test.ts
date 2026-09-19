import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const repo = join(import.meta.dir, "../../..");

describe("App snap parity", () => {
  test("iOS DTO decodes title+conversationId and canFollowup requires cid", () => {
    const swift = readFileSync(join(repo, "mobile/ios/ArmadaRemote/RelayAPI.swift"), "utf8");
    expect(swift).toMatch(/var title: String\?/);
    expect(swift).toMatch(/var conversationId: String\?/);
    const follow = swift.slice(swift.indexOf("var canFollowup"), swift.indexOf("var showsRetry"));
    expect(follow).toContain("conversationId");
    expect(follow).toContain("pendingAsk");
  });

  test("Android parseRun reads title+conversationId", () => {
    const kt = readFileSync(join(repo, "mobile/android/app/src/main/java/app/armada/remote/RelayClient.kt"), "utf8");
    expect(kt).toContain('optNullableString("title")');
    expect(kt).toContain('optNullableString("conversationId")');
  });
});
