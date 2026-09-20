import { describe, expect, test } from "bun:test";
import { applyPromptChunk, isPromptChunkBody, type PromptUploadSession } from "../src/promptUpload";
import { WAF_JSON_BODY_MAX, WAF_JSON_CHUNK_BYTES } from "../src/chunkUpload";

describe("applyPromptChunk", () => {
  test("assembles two UTF-8 chunks into the original prompt", () => {
    const sessions = new Map<string, PromptUploadSession>();
    const raw = Buffer.concat([Buffer.from("中".repeat(100), "utf8"), Buffer.alloc(WAF_JSON_CHUNK_BYTES + 80, 0x61)]);
    const a = applyPromptChunk(sessions, "tok", {
      uploadId: "p1", workspaceId: "m-1|/ws", totalSize: raw.length,
      index: 0, count: 2, data: raw.subarray(0, WAF_JSON_CHUNK_BYTES).toString("base64"),
    });
    expect(a).toEqual({ pending: true });
    const b = applyPromptChunk(sessions, "tok", {
      uploadId: "p1", totalSize: raw.length,
      index: 1, count: 2, data: raw.subarray(WAF_JSON_CHUNK_BYTES).toString("base64"),
    });
    expect("complete" in b && b.complete === raw.toString("utf8")).toBe(true);
    if ("complete" in b) expect(b.extra.workspaceId).toBe("m-1|/ws");
    expect(sessions.size).toBe(0);
  });

  test("last chunk arriving first still waits for holes and keeps workspaceId", () => {
    const sessions = new Map<string, PromptUploadSession>();
    const raw = Buffer.from("abcdefghij");
    const first = applyPromptChunk(sessions, "tok", {
      uploadId: "p-hole", totalSize: raw.length,
      index: 1, count: 2, data: raw.subarray(5).toString("base64"),
    });
    expect(first).toEqual({ pending: true });
    const second = applyPromptChunk(sessions, "tok", {
      uploadId: "p-hole", workspaceId: "m-1|/ws", totalSize: raw.length,
      index: 0, count: 2, data: raw.subarray(0, 5).toString("base64"),
    });
    expect("complete" in second && second.complete === "abcdefghij").toBe(true);
    if ("complete" in second) expect(second.extra.workspaceId).toBe("m-1|/ws");
  });

  test("a 6KiB prompt slice plus dispatch metadata stays under the uuWAF 10KiB cap", () => {
    const part = Buffer.alloc(WAF_JSON_CHUNK_BYTES, 0x61);
    const body = JSON.stringify({
      uploadId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      index: 0,
      count: 4,
      totalSize: 20_000,
      workspaceId: "m-1|/Users/me/very/long/path/to/workspace",
      attachmentIds: ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)],
      data: part.toString("base64"),
    });
    expect(Buffer.byteLength(body)).toBeLessThan(WAF_JSON_BODY_MAX);
  });

  test("isPromptChunkBody is true only when uploadId is present", () => {
    expect(isPromptChunkBody({ workspaceId: "m-1|/ws", prompt: "hi" })).toBe(false);
    expect(isPromptChunkBody({ uploadId: "u1", index: 0 })).toBe(true);
  });
});
