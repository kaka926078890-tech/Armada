import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  candidatePaths,
  decodeFileHref,
  looksLikeWorkspaceFileHref,
  workspaceFilePathFromHref,
} from "../src/workspaceFile";
import { readWorkspaceFile } from "../src/workspaceFileRead";

describe("workspace file hrefs", () => {
  test("md relative, repo-prefixed, file://, and armada-file are workspace files", () => {
    expect(workspaceFilePathFromHref("docs/foo.md")).toBe("docs/foo.md");
    expect(workspaceFilePathFromHref("armada/docs/foo.md")).toBe("armada/docs/foo.md");
    expect(workspaceFilePathFromHref("file:///Users/me/ws/docs/foo.md")).toBe("/Users/me/ws/docs/foo.md");
    expect(workspaceFilePathFromHref("armada-file://preview?p=docs%2Ffoo.md")).toBe("docs/foo.md");
  });

  test("http and mail links stay external", () => {
    expect(looksLikeWorkspaceFileHref("https://example.com/foo.md")).toBe(false);
    expect(looksLikeWorkspaceFileHref("mailto:a@b.c")).toBe(false);
    expect(workspaceFilePathFromHref("#section")).toBe(null);
    expect(workspaceFilePathFromHref("just-a-word")).toBe(null);
  });

  test("decode file:// Windows drive", () => {
    expect(decodeFileHref("file:///C:/ws/a.md")).toBe("C:/ws/a.md");
  });

  test("candidate paths try absolute, workspace-relative, and strip folder name", () => {
    expect(candidatePaths("/Users/me/armada", "docs/a.md")).toEqual([
      "/Users/me/armada/docs/a.md",
    ]);
    expect(candidatePaths("/Users/me/armada", "armada/docs/a.md")).toEqual([
      "/Users/me/armada/armada/docs/a.md",
      "/Users/me/armada/docs/a.md",
    ]);
    expect(candidatePaths("/Users/me/armada", "/Users/me/armada/docs/a.md")).toEqual([
      "/Users/me/armada/docs/a.md",
    ]);
  });
});

describe("readWorkspaceFile", () => {
  function ws(): string {
    const root = mkdtempSync(join(tmpdir(), "armada-wsfile-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "spec.md"), "# hello\n");
    writeFileSync(join(root, "secret.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, "notes.txt"), "plain");
    return root;
  }

  test("reads markdown inside the workspace", () => {
    const root = ws();
    const r = readWorkspaceFile({ workspaceRoot: root, path: "docs/spec.md", openWorkspaces: [root] });
    expect(r).toMatchObject({ ok: true, name: "spec.md", mime: "text/markdown", text: "# hello\n" });
  });

  test("strips the workspace folder prefix used in chat links", () => {
    const root = ws();
    const folder = root.split(/[\\/]/).filter(Boolean).at(-1)!;
    const r = readWorkspaceFile({
      workspaceRoot: root,
      path: `${folder}/docs/spec.md`,
      openWorkspaces: [root],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("# hello\n");
  });

  test("rejects path traversal and files outside the workspace", () => {
    const root = ws();
    const outside = join(root, "..", "outside.md");
    writeFileSync(outside, "nope");
    expect(readWorkspaceFile({
      workspaceRoot: root, path: "../outside.md", openWorkspaces: [root],
    })).toEqual({ ok: false, error: "PATH_OUTSIDE_WORKSPACE" });
    expect(readWorkspaceFile({
      workspaceRoot: root, path: outside, openWorkspaces: [root],
    })).toEqual({ ok: false, error: "PATH_OUTSIDE_WORKSPACE" });
  });

  test("symlink that escapes the workspace is outside", () => {
    const root = ws();
    const outside = join(root, "..", "escaped.md");
    writeFileSync(outside, "escaped");
    symlinkSync(outside, join(root, "docs", "link.md"));
    expect(readWorkspaceFile({
      workspaceRoot: root, path: "docs/link.md", openWorkspaces: [root],
    })).toEqual({ ok: false, error: "PATH_OUTSIDE_WORKSPACE" });
  });

  test("missing file, binary, and unknown type", () => {
    const root = ws();
    expect(readWorkspaceFile({
      workspaceRoot: root, path: "docs/nope.md", openWorkspaces: [root],
    })).toEqual({ ok: false, error: "FILE_NOT_FOUND" });
    expect(readWorkspaceFile({
      workspaceRoot: root, path: "secret.bin", openWorkspaces: [root],
    })).toEqual({ ok: false, error: "FILE_NOT_TEXT" });
    expect(readWorkspaceFile({
      workspaceRoot: root, path: "notes.txt", openWorkspaces: [root],
    })).toMatchObject({ ok: true, text: "plain" });
  });

  test("wrong window workspace is WORKSPACE_NOT_OPEN", () => {
    const root = ws();
    expect(readWorkspaceFile({
      workspaceRoot: root, path: "docs/spec.md", openWorkspaces: ["/other"],
    })).toEqual({ ok: false, error: "WORKSPACE_NOT_OPEN" });
  });
});
