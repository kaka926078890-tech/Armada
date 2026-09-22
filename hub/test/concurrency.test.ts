import { describe, expect, test } from "bun:test";
import { normalizePrompt } from "../../extension/src/promptNormalize";
import { limitsFromEnv, extensionSupportsMultiRunPerWindow, httpStatusForRunError, followupOutcome, ACTIVE_STATUSES, TERMINAL_STATUSES, OCCUPYING_STATUSES, LIVE_STATUSES, ENDED_STATUSES, INJECTING_STATUSES, PROGRESSING_STATUSES, sqlStatusIn, RETRY_STATUSES } from "../src/concurrency";

describe("normalizePrompt", () => {
  test("trims, strips CR, collapses whitespace", () => {
    expect(normalizePrompt("  hello\r\n  world  ")).toBe("hello world");
  });
});

describe("limitsFromEnv", () => {
  test("defaults 8/4/multi-on", () => {
    expect(limitsFromEnv({})).toEqual({ maxPerMachine: 8, maxPerWorkspace: 4, multiRunPerWindow: true });
  });
  test("clamps and enforces M <= N", () => {
    const l = limitsFromEnv({
      ARMADA_MAX_RUNS_PER_MACHINE: "2",
      ARMADA_MAX_RUNS_PER_WORKSPACE: "9",
    });
    expect(l.maxPerMachine).toBe(2);
    expect(l.maxPerWorkspace).toBe(2);
  });
  test("MULTI_RUN_PER_WINDOW=0 disables same-window parallel", () => {
    expect(limitsFromEnv({ ARMADA_MULTI_RUN_PER_WINDOW: "0" }).multiRunPerWindow).toBe(false);
  });
});

describe("extensionSupportsMultiRunPerWindow", () => {
  test("0.4.0+ yes, missing and 0.3.8 no", () => {
    expect(extensionSupportsMultiRunPerWindow("0.4.0")).toBe(true);
    expect(extensionSupportsMultiRunPerWindow("0.3.8")).toBe(false);
    expect(extensionSupportsMultiRunPerWindow(null)).toBe(false);
  });
});

describe("status tables", () => {
  test("ACTIVE / TERMINAL / OCCUPYING / LIVE membership is owned here", () => {
    expect([...ACTIVE_STATUSES]).toEqual(["created", "dispatched", "binding", "running"]);
    expect([...TERMINAL_STATUSES]).toEqual(["completed", "error", "aborted", "cancelled"]);
    expect([...OCCUPYING_STATUSES]).toEqual(["queued", "dispatched", "binding", "running"]);
    expect([...LIVE_STATUSES]).toEqual(["created", "queued", "dispatched", "binding", "running"]);
    expect([...ENDED_STATUSES]).toEqual(["completed", "error", "aborted", "cancelled", "unknown"]);
    expect([...INJECTING_STATUSES]).toEqual(["dispatched", "binding"]);
    expect([...PROGRESSING_STATUSES]).toEqual(["dispatched", "binding", "running"]);
    expect([...RETRY_STATUSES]).toEqual(["error", "unknown", "aborted"]);
    expect(ACTIVE_STATUSES).not.toContain("queued");
    expect(OCCUPYING_STATUSES).not.toContain("created");
    expect(LIVE_STATUSES).toContain("queued");
    expect(sqlStatusIn(OCCUPYING_STATUSES)).toBe("'queued','dispatched','binding','running'");
  });

  test("runs.ts and ingest.ts import ACTIVE from concurrency, not a local copy", async () => {
    const runs = await Bun.file(new URL("../src/runs.ts", import.meta.url)).text();
    const ingest = await Bun.file(new URL("../src/ingest.ts", import.meta.url)).text();
    expect(runs).toMatch(/ACTIVE_STATUSES/);
    expect(runs).toMatch(/ENDED_STATUSES/);
    expect(runs).toMatch(/OCCUPYING_STATUSES/);
    expect(runs).toMatch(/sqlStatusIn\(OCCUPYING_STATUSES\)/);
    expect(runs).not.toMatch(/status IN \('queued','dispatched','binding','running'\)/);
    expect(runs).not.toMatch(/const ACTIVE = \[/);
    expect(ingest).toMatch(/ACTIVE_STATUSES/);
    expect(ingest).toMatch(/TERMINAL_STATUSES/);
    expect(ingest).toMatch(/OCCUPYING_STATUSES/);
    expect(ingest).not.toMatch(/const ACTIVE = \[/);
  });

  test("Rel-M7: board and App isLive copies match LIVE_STATUSES", async () => {
    const liveLit = [...LIVE_STATUSES].map((s) => `"${s}"`).join(", ");
    const board = await Bun.file(new URL("../web/src/boardState.ts", import.meta.url)).text();
    const ios = await Bun.file(new URL("../../mobile/ios/ArmadaRemote/RelayAPI.swift", import.meta.url)).text();
    const android = await Bun.file(new URL("../../mobile/android/core/src/main/kotlin/app/armada/remote/Models.kt", import.meta.url)).text();
    expect(board).toMatch(/LIVE_STATUSES/);
    expect(board).not.toMatch(/new Set\(\["created", "queued"/);
    expect(ios).toContain(`[${liveLit}].contains(status)`);
    expect(android).toContain(`setOf(${liveLit})`);
  });
});

describe("httpStatusForRunError", () => {
  test("maps limit/collision/offline", () => {
    expect(httpStatusForRunError("RUN_LIMIT")).toBe(429);
    expect(httpStatusForRunError("PROMPT_COLLISION")).toBe(409);
    expect(httpStatusForRunError("CONVERSATION_BUSY")).toBe(409);
    expect(httpStatusForRunError("INJECT_SLOT_BUSY")).toBe(409);
    expect(httpStatusForRunError("WINDOW_BUSY")).toBe(409);
    expect(httpStatusForRunError("MACHINE_OFFLINE")).toBe(400);
    expect(httpStatusForRunError("NOT_FOUND")).toBe(404);
    expect(httpStatusForRunError("FILE_NOT_FOUND")).toBe(404);
    expect(httpStatusForRunError("ATTACHMENT_TOTAL_TOO_LARGE")).toBe(413);
    expect(httpStatusForRunError("FILE_TOO_LARGE")).toBe(413);
    expect(httpStatusForRunError("OUTBOUND_LIMIT")).toBe(429);
    expect(httpStatusForRunError("OUTBOUND_TEXT_ONLY")).toBe(409);
  });

  test("ASK_* and occupancy conflicts are 409", () => {
    expect(httpStatusForRunError("ASK_INVALID_OPTION")).toBe(409);
    expect(httpStatusForRunError("ASK_TEXT_EMPTY")).toBe(409);
    expect(httpStatusForRunError("ASK_TEXT_TOO_LONG")).toBe(409);
    expect(httpStatusForRunError("ASK_IN_FLIGHT")).toBe(409);
    expect(httpStatusForRunError("NO_PENDING_ASK")).toBe(409);
    expect(httpStatusForRunError("ASK_MISMATCH")).toBe(409);
    expect(httpStatusForRunError("ALREADY_ACTIVE")).toBe(409);
    expect(httpStatusForRunError("RUN_BUSY")).toBe(409);
    expect(httpStatusForRunError("ALREADY_TERMINAL")).toBe(409);
  });
});

describe("followupOutcome", () => {
  test("running is queued; idle dispatch is injected", () => {
    expect(followupOutcome("running")).toBe("queued");
    expect(followupOutcome("dispatched")).toBe("injected");
    expect(followupOutcome("binding")).toBe("injected");
    expect(followupOutcome("completed")).toBe("injected");
  });
});
