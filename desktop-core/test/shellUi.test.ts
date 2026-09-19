import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { formatJoinUri, parseJoinUri } from "../src/joinUri";
import {
  attachBanner,
  boardUrl,
  canStartJoin,
  copiedToast,
  defaultLandingMode,
  joinButtonLabel,
  decideBoardReopen,
  decideNeedToken,
  firstArmadaJoinUri,
  isLocalOwnedBoard,
  noShareIpCopy,
  parseBoardSession,
  parseDesktopBoardRequest,
  parsePastedJoin,
  recreateFleetCopy,
  restoreHubCopy,
  serializeBoardSession,
  selectShareCandidate,
  shareJoinUri,
  shouldOpenBoardAfterCreate,
  shouldShowCreate,
  fleetErrorCopy,
} from "../src/shellUi";

const token = "a".repeat(64);

describe("boardUrl", () => {
  test("opens hub origin with query token, desktop flag, and no extra path", () => {
    expect(boardUrl("127.0.0.1:7380", token)).toBe(`http://127.0.0.1:7380/?token=${token}&desktop=1`);
    expect(boardUrl("192.168.1.23:7380", token)).toBe(`http://192.168.1.23:7380/?token=${token}&desktop=1`);
  });
});

describe("shouldShowCreate", () => {
  test("hides 创建舰队 on windows", () => {
    expect(shouldShowCreate("windows")).toBe(false);
    expect(shouldShowCreate("macos")).toBe(true);
    expect(shouldShowCreate("linux")).toBe(true);
  });
});

describe("defaultLandingMode", () => {
  test("create on macOS, join only on windows", () => {
    expect(defaultLandingMode("macos")).toBe("create");
    expect(defaultLandingMode("windows")).toBe("join");
  });
});

describe("parseDesktopBoardRequest", () => {
  test("accepts open-workspace and get-share-link from the board iframe", () => {
    expect(parseDesktopBoardRequest({ source: "armada-desktop", type: "open-workspace" })).toEqual({ type: "open-workspace" });
    expect(parseDesktopBoardRequest({ source: "armada-desktop", type: "repair-cdp" })).toEqual({ type: "repair-cdp" });
    expect(parseDesktopBoardRequest({ source: "armada-desktop", type: "get-share-link" })).toEqual({ type: "get-share-link" });
    expect(parseDesktopBoardRequest({ source: "armada-desktop", type: "leave-fleet" })).toEqual({ type: "leave-fleet" });
    expect(parseDesktopBoardRequest({ source: "armada-desktop", type: "need-token" })).toEqual({ type: "need-token" });
  });

  test("parses run.alert with three ids", () => {
    expect(parseDesktopBoardRequest({
      source: "armada-desktop",
      type: "run.alert",
      runId: "r-1",
      machineId: "m-1",
      workspaceRoot: "/ws/a",
      title: "Armada 任务完成",
      body: "fix",
    })).toEqual({
      type: "run.alert",
      runId: "r-1",
      machineId: "m-1",
      workspaceRoot: "/ws/a",
      title: "Armada 任务完成",
      body: "fix",
    });
  });

  test("drops run.alert missing workspaceRoot", () => {
    expect(parseDesktopBoardRequest({
      source: "armada-desktop", type: "run.alert", runId: "r-1", machineId: "m-1", title: "t", body: "b",
    })).toBeNull();
  });

  test("ignores other origins and types", () => {
    expect(parseDesktopBoardRequest({ source: "other", type: "open-workspace" })).toBeNull();
    expect(parseDesktopBoardRequest({ source: "armada-desktop", type: "dispatch" })).toBeNull();
    expect(parseDesktopBoardRequest(null)).toBeNull();
  });
});

describe("board session", () => {
  test("round-trips origin and token for host reopen", () => {
    const raw = serializeBoardSession({ origin: "127.0.0.1:7380", token });
    expect(parseBoardSession(raw)).toEqual({ origin: "127.0.0.1:7380", token });
  });

  test("drops incomplete or junk session", () => {
    expect(parseBoardSession(null)).toBeNull();
    expect(parseBoardSession("")).toBeNull();
    expect(parseBoardSession("{}")).toBeNull();
    expect(parseBoardSession(JSON.stringify({ origin: "127.0.0.1:7380", token: "" }))).toBeNull();
  });

  test("desktop shell persists the owned board in localStorage so overlay reopen restores the sidecar", () => {
    const main = readFileSync(join(import.meta.dir, "../../desktop/src/main.ts"), "utf8");
    expect(main).toContain("localStorage.setItem(BOARD_SESSION_KEY");
    expect(main).toContain("localStorage.getItem(BOARD_SESSION_KEY");
    expect(main).toContain("localStorage.removeItem(BOARD_SESSION_KEY");
    expect(main).not.toMatch(/sessionStorage\.(setItem|getItem|removeItem)\(BOARD_SESSION_KEY/);
    expect(main).toContain("void restoreOwnedHub()");
    expect(main).toContain("isLocalOwnedBoard(lastBoard.origin)");
  });
});

describe("decideBoardReopen", () => {
  test("first need-token reopens; cooldown then give-up after two reopens", () => {
    expect(decideBoardReopen({ reopenCount: 0, lastAt: null, now: 1000 })).toBe("reopen");
    expect(decideBoardReopen({ reopenCount: 1, lastAt: 1000, now: 2000 })).toBe("wait");
    expect(decideBoardReopen({ reopenCount: 1, lastAt: 1000, now: 1000 + 8000 })).toBe("reopen");
    expect(decideBoardReopen({ reopenCount: 2, lastAt: 9000, now: 20000 })).toBe("give-up");
  });
});

describe("decideNeedToken", () => {
  test("no session still asks to recreate", () => {
    expect(decideNeedToken({ hasSession: false, reopenCount: 0, lastAt: null, now: 0 })).toBe("recreate");
    expect(recreateFleetCopy()).toMatch(/重新创建或加入/);
  });

  test("session that exhausted reopens restores the owned hub instead of recreating the fleet", () => {
    expect(decideNeedToken({ hasSession: true, reopenCount: 0, lastAt: null, now: 1000 })).toBe("reopen");
    expect(decideNeedToken({ hasSession: true, reopenCount: 1, lastAt: 1000, now: 2000 })).toBe("wait");
    expect(decideNeedToken({ hasSession: true, reopenCount: 2, lastAt: 9000, now: 20000 })).toBe("restore-hub");
    expect(restoreHubCopy()).toMatch(/恢复/);
    expect(restoreHubCopy()).not.toMatch(/重新创建/);
  });

  test("only loopback boards own the sidecar", () => {
    expect(isLocalOwnedBoard("127.0.0.1:7380")).toBe(true);
    expect(isLocalOwnedBoard("localhost:7380")).toBe(true);
    expect(isLocalOwnedBoard("192.168.1.23:7380")).toBe(false);
  });
});

describe("create completion gates", () => {
  test("zero RFC1918 candidates do not open the board", () => {
    expect(shouldOpenBoardAfterCreate([])).toBe(false);
    expect(
      shouldOpenBoardAfterCreate([{ ipv4: "192.168.1.23", name: "en0", maybeUnreachable: false }]),
    ).toBe(true);
  });

  test("zero-candidate copy tells operator to use LAN or hand-fill, not clipboard", () => {
    const copy = noShareIpCopy();
    expect(copy).toMatch(/局域网/);
    expect(copy).toMatch(/手工|手填/);
    expect(copy.toLowerCase()).not.toMatch(/clipboard|剪贴板已/);
    expect(copy).toMatch(/剪贴板/);
  });
});

describe("shareJoinUri", () => {
  test("uses formatJoinUri of selected ipv4:7380 once", () => {
    const uri = shareJoinUri("192.168.1.23", token);
    expect(uri).toBe(formatJoinUri("192.168.1.23:7380", token));
    expect(parseJoinUri(uri)).toMatchObject({ hubHostPort: "192.168.1.23:7380", token });
  });

  test("selects first candidate (reachable en/eth first)", () => {
    const selected = selectShareCandidate([
      { ipv4: "192.168.1.23", name: "en0", maybeUnreachable: false },
      { ipv4: "192.168.0.5", name: "wlan0", maybeUnreachable: true },
    ]);
    expect(selected?.ipv4).toBe("192.168.1.23");
    expect(selectShareCandidate([])).toBeNull();
  });
});

describe("copiedToast", () => {
  test("does not include token", () => {
    const toast = copiedToast();
    expect(toast).toBeTruthy();
    expect(toast.includes(token)).toBe(false);
    expect(toast.toLowerCase().includes("token")).toBe(false);
  });
});

describe("join in-flight", () => {
  test("second join is ignored while the first is still running", () => {
    expect(canStartJoin(false)).toBe(true);
    expect(canStartJoin(true)).toBe(false);
    expect(joinButtonLabel(false)).toBe("加入舰队");
    expect(joinButtonLabel(true)).toBe("正在加入…");
  });
});

describe("parsePastedJoin", () => {
  test("incomplete and invalid never yield a join uri", () => {
    expect(parsePastedJoin("armada://join?hub=1.2.3.4:7380")).toEqual({ error: "incomplete" });
    expect(parsePastedJoin("https://join?hub=1.2.3.4:7380&token=ab")).toEqual({ error: "invalid" });
  });

  test("deep link urls go through the same paste parser", () => {
    const raw = formatJoinUri("10.0.0.2:7380", token);
    expect(firstArmadaJoinUri(["https://example", raw])).toBe(raw);
    expect(parsePastedJoin(firstArmadaJoinUri([raw])!)).toEqual({ uri: raw });
    expect(firstArmadaJoinUri(["https://example.com"])).toBeNull();
  });
});

describe("fleetErrorCopy", () => {
  test("maps ticket unauthorized instead of generic failure", () => {
    expect(fleetErrorCopy("unauthorized")).toBe("加入票据无效或已过期，请让中台重新打开可发现");
    expect(fleetErrorCopy("Command join_fleet failed: unauthorized")).toBe(
      "加入票据无效或已过期，请让中台重新打开可发现",
    );
    expect(fleetErrorCopy("unreachable")).toBe("无法连接中台");
    expect(fleetErrorCopy("something-else")).toBe("操作失败");
  });
});

describe("attachBanner", () => {
  test("red bar when hooks or settings failed; create is not attached", () => {
    const hooks = attachBanner({
      vsix: "ok",
      hooks: "failed",
      settings: "ok",
      hubUrlWritten: "127.0.0.1:7380",
    });
    expect(hooks.kind).toBe("red");
    expect(hooks.lines.join(" ")).toMatch(/hooks/i);

    const settings = attachBanner({
      vsix: "ok",
      hooks: "ok",
      settings: "failed",
      hubUrlWritten: "127.0.0.1:7380",
    });
    expect(settings.kind).toBe("red");
    expect(settings.lines.join(" ")).toMatch(/settings/i);

    const missing = attachBanner(null);
    expect(missing.kind).toBe("red");
    expect(missing.lines.join("")).not.toMatch(/已接入|已连接/);
  });

  test("vsix manual path only when vsixPath is present", () => {
    const withPath = attachBanner({
      vsix: "manual-path-shown",
      hooks: "ok",
      settings: "ok",
      hubUrlWritten: "127.0.0.1:7380",
      vsixPath: "/tmp/armada-agent.vsix",
    });
    expect(withPath.lines.some((l) => l.includes("/tmp/armada-agent.vsix"))).toBe(true);

    const noPath = attachBanner({
      vsix: "manual-path-shown",
      hooks: "ok",
      settings: "ok",
      hubUrlWritten: "127.0.0.1:7380",
    });
    expect(noPath.lines.join("")).not.toMatch(/\.vsix/);
    expect(noPath.kind).not.toBe("red");
  });
});
