import { describe, expect, test } from "bun:test";
import { DESKTOP_BOARD_SOURCE, DESKTOP_HOST_SOURCE, parseHostOpenRun, requestDesktop, requestDesktopAlert } from "../src/desktopBridge";

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

test("requestDesktopAlert posts run.alert payload", () => {
  const posted: unknown[] = [];
  const original = globalThis.window;
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  (globalThis as { window: unknown }).window = { parent, postMessage: () => {} };
  try {
    requestDesktopAlert({
      runId: "r-1",
      machineId: "m-1",
      workspaceRoot: "/ws/a",
      title: "Armada 任务完成",
      body: "fix",
    });
  } finally {
    (globalThis as { window: typeof original }).window = original;
  }
  expect(posted).toEqual([{
    source: DESKTOP_BOARD_SOURCE,
    type: "run.alert",
    runId: "r-1",
    machineId: "m-1",
    workspaceRoot: "/ws/a",
    title: "Armada 任务完成",
    body: "fix",
  }]);
});

test("parseHostOpenRun requires parent source and three ids", () => {
  const parent = {} as Window;
  const payload = {
    source: DESKTOP_HOST_SOURCE,
    type: "open-run",
    runId: "r-1",
    machineId: "m-1",
    workspaceRoot: "/ws/b",
  };
  expect(parseHostOpenRun(payload, parent, parent)).toEqual({
    runId: "r-1",
    machineId: "m-1",
    workspaceRoot: "/ws/b",
  });
  expect(parseHostOpenRun(payload, {}, parent)).toBeNull();
  expect(parseHostOpenRun({ ...payload, workspaceRoot: "" }, parent, parent)).toBeNull();
});
