import { describe, expect, test } from "bun:test";
import { pickCdpPage, titleMatchesWorkspace } from "../src/cdpPage";

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
});
