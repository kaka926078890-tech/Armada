import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { materializeInboxFile, uniqueInboxFilename } from "../src/workspaceInbox";

describe("workspaceInbox", () => {
  test("unique name prefixes sha and strips path", () => {
    expect(uniqueInboxFilename("abcdef012345", "../x/notes.txt")).toBe("abcdef01-notes.txt");
  });

  test("writes only under inbox/runId", () => {
    const root = mkdtempSync(join(tmpdir(), "armada-inbox-"));
    const { absPath, relPath } = materializeInboxFile(root, "r1", "abcdef01-notes.txt", Buffer.from("hi"));
    expect(relPath).toBe(".armada/inbox/r1/abcdef01-notes.txt");
    expect(readFileSync(absPath, "utf8")).toBe("hi");
    expect(() => materializeInboxFile(root, "r1", "../escape.txt", Buffer.from("x"))).toThrow("BAD_INBOX_NAME");
  });
});
