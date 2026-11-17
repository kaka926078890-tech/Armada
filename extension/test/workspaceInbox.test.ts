import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { materializeInboxFile, uniqueInboxFilename } from "../src/workspaceInbox";

describe("workspaceInbox", () => {
  test("unique name prefixes sha and run, and strips path", () => {
    expect(uniqueInboxFilename("abcdef012345", "r1", "../x/notes.txt")).toBe("abcdef01-r1-notes.txt");
  });

  test("the same blob on two runs does not share a basename", () => {
    const sha = "299ede61d307b00e5d2e6b48ef4249599d563b064efed331c1d678f409218783";
    const name = "OpenMausBot设计与技术实现参考-2026-11-16.md";
    const a = uniqueInboxFilename(sha, "r-6a3bb21a-4c19-4e1b-9e2f-21725e19f587", name);
    const b = uniqueInboxFilename(sha, "r-4900ac33-9397-442a-93a9-30d812dfb558", name);
    expect(a).not.toBe(b);
    expect(a).toBe(`299ede61-r-6a3bb21a-4c19-4e1b-9e2f-21725e19f587-${name}`);
    expect(uniqueInboxFilename(sha, "r-4900ac33-9397-442a-93a9-30d812dfb558", name)).toBe(b);
  });

  test("writes only under inbox/runId", () => {
    const root = mkdtempSync(join(tmpdir(), "armada-inbox-"));
    const { absPath, relPath } = materializeInboxFile(root, "r1", "abcdef01-notes.txt", Buffer.from("hi"));
    expect(relPath).toBe(".armada/inbox/r1/abcdef01-notes.txt");
    expect(readFileSync(absPath, "utf8")).toBe("hi");
    expect(() => materializeInboxFile(root, "r1", "../escape.txt", Buffer.from("x"))).toThrow("BAD_INBOX_NAME");
  });
});
