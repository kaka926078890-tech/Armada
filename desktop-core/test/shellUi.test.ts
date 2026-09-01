import { describe, expect, test } from "bun:test";
import { formatJoinUri, parseJoinUri } from "../src/joinUri";
import {
  attachBanner,
  boardUrl,
  copiedToast,
  firstArmadaJoinUri,
  noShareIpCopy,
  parsePastedJoin,
  selectShareCandidate,
  shareJoinUri,
  shouldOpenBoardAfterCreate,
  shouldShowCreate,
} from "../src/shellUi";

const token = "a".repeat(64);

describe("boardUrl", () => {
  test("opens hub origin with query token and no extra path", () => {
    expect(boardUrl("127.0.0.1:7380", token)).toBe(`http://127.0.0.1:7380/?token=${token}`);
    expect(boardUrl("192.168.1.23:7380", token)).toBe(`http://192.168.1.23:7380/?token=${token}`);
  });
});

describe("shouldShowCreate", () => {
  test("hides 创建舰队 on windows", () => {
    expect(shouldShowCreate("windows")).toBe(false);
    expect(shouldShowCreate("macos")).toBe(true);
    expect(shouldShowCreate("linux")).toBe(true);
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
