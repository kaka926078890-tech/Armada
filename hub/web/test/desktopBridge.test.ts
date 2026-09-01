import { describe, expect, test } from "bun:test";
import { DESKTOP_BOARD_SOURCE, requestDesktop } from "../src/desktopBridge";

test("requestDesktop posts to parent with the shared source", () => {
  const posted: unknown[] = [];
  const original = globalThis.window;
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  (globalThis as { window: unknown }).window = { parent, postMessage: () => {} };
  try {
    requestDesktop("open-workspace");
    requestDesktop("get-share-link");
    requestDesktop("leave-fleet");
  } finally {
    (globalThis as { window: typeof original }).window = original;
  }
  expect(posted).toEqual([
    { source: DESKTOP_BOARD_SOURCE, type: "open-workspace" },
    { source: DESKTOP_BOARD_SOURCE, type: "get-share-link" },
    { source: DESKTOP_BOARD_SOURCE, type: "leave-fleet" },
  ]);
});
