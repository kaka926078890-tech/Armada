import { describe, expect, test } from "bun:test";
import { applyBlobChunk, BLOB_UPLOAD_CHUNK_BYTES, type BlobUploadSession } from "../src/blobUpload";

describe("applyBlobChunk", () => {
  test("assembles two chunks into the original bytes", () => {
    const sessions = new Map<string, BlobUploadSession>();
    const raw = Buffer.alloc(BLOB_UPLOAD_CHUNK_BYTES + 20, 7);
    raw[0] = 0xff; raw[1] = 0xd8; raw[2] = 0xff;
    const a = applyBlobChunk(sessions, "tok", {
      uploadId: "u1", name: "x.jpg", mime: "image/jpeg", totalSize: raw.length,
      index: 0, count: 2, data: raw.subarray(0, BLOB_UPLOAD_CHUNK_BYTES).toString("base64"),
    });
    expect(a).toEqual({ pending: true });
    const b = applyBlobChunk(sessions, "tok", {
      uploadId: "u1", name: "x.jpg", mime: "image/jpeg", totalSize: raw.length,
      index: 1, count: 2, data: raw.subarray(BLOB_UPLOAD_CHUNK_BYTES).toString("base64"),
    });
    expect("complete" in b && b.complete.equals(raw)).toBe(true);
    expect(sessions.size).toBe(0);
  });

  test("last chunk arriving first still waits for holes", () => {
    const sessions = new Map<string, BlobUploadSession>();
    const raw = Buffer.from("abcdefghij");
    const first = applyBlobChunk(sessions, "tok", {
      uploadId: "u-hole", name: "x.jpg", mime: "image/jpeg", totalSize: raw.length,
      index: 1, count: 2, data: raw.subarray(5).toString("base64"),
    });
    expect(first).toEqual({ pending: true });
    const second = applyBlobChunk(sessions, "tok", {
      uploadId: "u-hole", name: "x.jpg", mime: "image/jpeg", totalSize: raw.length,
      index: 0, count: 2, data: raw.subarray(0, 5).toString("base64"),
    });
    expect("complete" in second && second.complete.equals(raw)).toBe(true);
  });

  test("rejects a foreign token on an in-flight upload", () => {
    const sessions = new Map<string, BlobUploadSession>();
    applyBlobChunk(sessions, "a", {
      uploadId: "u2", name: "x.jpg", mime: "image/jpeg", totalSize: 4,
      index: 0, count: 2, data: Buffer.from("abcd").toString("base64"),
    });
    expect(applyBlobChunk(sessions, "b", {
      uploadId: "u2", name: "x.jpg", mime: "image/jpeg", totalSize: 4,
      index: 1, count: 2, data: Buffer.from("abcd").toString("base64"),
    })).toEqual({ error: "unauthorized", status: 401 });
  });
});
