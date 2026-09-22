import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { ARMADA_FILE_SCHEME, looksLikeWorkspaceFileHref, workspaceFilePathFromHref } from "../extension/src/workspaceFile";

const root = join(dirname(fileURLToPath(import.meta.url)));

describe("workspace file hrefs stay aligned on App", () => {
  test("iOS and Android rewrite previewable md links to armada-file", () => {
    expect(workspaceFilePathFromHref("docs/foo.md")).toBe("docs/foo.md");
    expect(looksLikeWorkspaceFileHref("https://example.com/a.md")).toBe(false);
    const swift = readFileSync(join(root, "ios/ArmadaRemote/MarkdownView.swift"), "utf8");
    const kt = readFileSync(join(root, "android/core/src/main/kotlin/app/armada/remote/WorkspaceFile.kt"), "utf8");
    const html = readFileSync(join(root, "android/core/src/main/kotlin/app/armada/remote/MarkdownHtml.kt"), "utf8");
    expect(swift).toContain(`static let scheme = "${ARMADA_FILE_SCHEME}"`);
    expect(kt).toContain(`const val SCHEME = "${ARMADA_FILE_SCHEME}"`);
    expect(html).toContain("WorkspaceFile.rewriteHref");
    expect(swift).toContain("WorkspaceFileLink.rewrite");
  });
});
