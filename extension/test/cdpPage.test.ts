import { describe, expect, test } from "bun:test";
import { isDuplicateWorkspaceTitle, pickCdpPage, titleMatchesWorkspace } from "../src/cdpPage";

describe("titleMatchesWorkspace", () => {
  test("matches Cursor em-dash title and exact folder title", () => {
    expect(titleMatchesWorkspace("hello.txt — armada-test-ws", "armada-test-ws")).toBe(true);
    expect(titleMatchesWorkspace("armada-test-ws", "armada-test-ws")).toBe(true);
    expect(titleMatchesWorkspace("● hello.txt — armada-test-ws", "armada-test-ws")).toBe(true);
  });

  test("does not match a longer sibling folder via includes", () => {
    expect(titleMatchesWorkspace("b.ts — armada-test-ws", "armada")).toBe(false);
    expect(titleMatchesWorkspace("a.ts — armada", "armada-test-ws")).toBe(false);
  });

  test("matches Windows file - folder - Cursor title (2026-09-18 Win Destop CDP)", () => {
    expect(titleMatchesWorkspace("logo.png - work - Cursor", "work")).toBe(true);
    expect(titleMatchesWorkspace("● logo.png - work - Cursor", "work")).toBe(true);
    expect(titleMatchesWorkspace("work - Cursor", "work")).toBe(true);
  });

  test("Windows sibling folder still does not match via includes", () => {
    expect(titleMatchesWorkspace("b.ts - armada-test-ws - Cursor", "armada")).toBe(false);
    expect(titleMatchesWorkspace("a.ts - armada - Cursor", "armada-test-ws")).toBe(false);
    expect(titleMatchesWorkspace("logo.png - work - Cursor", "Cursor")).toBe(false);
  });

  const workWin = "work";

  test("Windows dirty titles drop product-name-right noise (Untracked/Modified/problems)", () => {
    expect(titleMatchesWorkspace(
      "2026-09-20-codex-cli-finsafe-integration-issues.md - work - Cursor - Untracked",
      workWin,
    )).toBe(true);
    expect(titleMatchesWorkspace("SKILL.md - work - Cursor - Modified", workWin)).toBe(true);
    expect(titleMatchesWorkspace("file.ts - work - Cursor - 1 problem", workWin)).toBe(true);
    expect(titleMatchesWorkspace("file.ts - work - Cursor - Conflict: Both Added", workWin)).toBe(true);
  });

  test("Mac em-dash, Profile, and Code product names still match folder token", () => {
    expect(titleMatchesWorkspace("file.ts — work — Cursor", workWin)).toBe(true);
    expect(titleMatchesWorkspace("file.ts - work - Dev - Cursor", workWin)).toBe(true);
    expect(titleMatchesWorkspace("file.ts - work - Visual Studio Code", workWin)).toBe(true);
    expect(titleMatchesWorkspace("file.ts - work - Code - Insiders", workWin)).toBe(true);
    expect(titleMatchesWorkspace("file.ts - work - Code - OSS", workWin)).toBe(true);
  });

  test("does not treat first segment, sibling folder, or Cursor Agents as workspace", () => {
    expect(titleMatchesWorkspace("b.ts - armada-test-ws - Cursor", "armada")).toBe(false);
    expect(titleMatchesWorkspace("Cursor Agents", workWin)).toBe(false);
    expect(titleMatchesWorkspace("work - other - Cursor", workWin)).toBe(false);
  });

  test("CLI .code-workspace window titled folder (Workspace) matches that folder", () => {
    expect(titleMatchesWorkspace("desk (Workspace)", "desk")).toBe(true);
    expect(titleMatchesWorkspace("work (Workspace)", workWin)).toBe(true);
    expect(titleMatchesWorkspace("armada-open-desk (Workspace)", "desk")).toBe(false);
  });

  test("duplicateWorkspaceInNewWindow title is not a folder match (r-b703b94a)", () => {
    expect(titleMatchesWorkspace("Untitled (Workspace)", "desk")).toBe(false);
    expect(isDuplicateWorkspaceTitle("Untitled (Workspace)")).toBe(true);
    expect(isDuplicateWorkspaceTitle("● Untitled (Workspace)")).toBe(true);
    expect(isDuplicateWorkspaceTitle("desk (Workspace)")).toBe(false);
    expect(isDuplicateWorkspaceTitle("armada-open-desk (Workspace)")).toBe(false);
  });
});

describe("pickCdpPage", () => {
  const page = (title: string, ws: string) => ({
    type: "page",
    title,
    webSocketDebuggerUrl: ws,
  });

  test("picks the exact workspace when a sibling title would match includes()", () => {
    const hit = pickCdpPage(
      [
        page("b.ts — armada-test-ws", "ws://wrong"),
        page("a.ts — armada", "ws://right"),
      ],
      "/Users/x/armada",
    );
    expect(hit).toEqual({ ok: true, wsUrl: "ws://right" });
  });

  test("fail-closed when two pages belong to the same folder", () => {
    const hit = pickCdpPage(
      [
        page("a.ts — armada", "ws://one"),
        page("b.ts — armada", "ws://two"),
      ],
      "/Users/x/armada",
    );
    expect(hit).toEqual({ ok: false, reason: "WINDOW_TARGET_AMBIGUOUS" });
  });

  test("WINDOW_TARGET_NOT_FOUND when nothing matches", () => {
    expect(pickCdpPage([page("other-ws", "ws://x")], "/Users/x/armada")).toEqual({
      ok: false,
      reason: "WINDOW_TARGET_NOT_FOUND",
    });
  });

  test("picks Windows title with trailing Cursor app suffix", () => {
    const hit = pickCdpPage(
      [page("logo.png - work - Cursor", "ws://win")],
      "C:\\Users\\PC\\Desktop\\work",
    );
    expect(hit).toEqual({ ok: true, wsUrl: "ws://win" });
  });

  test("Windows sibling folder still loses to the exact folder page", () => {
    const hit = pickCdpPage(
      [
        page("b.ts - armada-test-ws - Cursor", "ws://wrong"),
        page("a.ts - armada - Cursor", "ws://right"),
      ],
      "C:\\Users\\x\\armada",
    );
    expect(hit).toEqual({ ok: true, wsUrl: "ws://right" });
  });

  test("picks Windows Untracked title for Desktop/work", () => {
    const hit = pickCdpPage(
      [page("2026-09-20-codex-cli-finsafe-integration-issues.md - work - Cursor - Untracked", "ws://win")],
      "C:\\Users\\PC\\Desktop\\work",
    );
    expect(hit).toEqual({ ok: true, wsUrl: "ws://win" });
  });

  test("two Untracked work pages → WINDOW_TARGET_AMBIGUOUS", () => {
    const hit = pickCdpPage(
      [
        page("a.ts - work - Cursor - Untracked", "ws://one"),
        page("b.ts - work - Cursor - Untracked", "ws://two"),
      ],
      "C:\\Users\\PC\\Desktop\\work",
    );
    expect(hit).toEqual({ ok: false, reason: "WINDOW_TARGET_AMBIGUOUS" });
  });
});
