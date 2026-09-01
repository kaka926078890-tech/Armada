import { describe, expect, test } from "bun:test";
import { resolveHubTargets } from "../src/hubUrl";

test("create always loopback", () => {
  const r = resolveHubTargets({
    role: "create", parsedHost: "192.168.1.23", parsedPort: 7380,
    localShareCandidates: ["192.168.1.23"], existingHubUrl: null,
  });
  expect(r).toEqual({
    cursorHubUrl: "127.0.0.1:7380",
    webviewOrigin: "127.0.0.1:7380",
    joinSelf: false,
    overwriteCursorHubUrl: true,
  });
});

test("join remote uses LAN host", () => {
  const r = resolveHubTargets({
    role: "join", parsedHost: "192.168.1.23", parsedPort: 7380,
    localShareCandidates: ["10.0.0.2"], existingHubUrl: null,
  });
  expect(r.cursorHubUrl).toBe("192.168.1.23:7380");
  expect(r.webviewOrigin).toBe("192.168.1.23:7380");
  expect(r.joinSelf).toBe(false);
});

test("join self does not overwrite loopback settings", () => {
  const r = resolveHubTargets({
    role: "join", parsedHost: "192.168.1.23", parsedPort: 7380,
    localShareCandidates: ["192.168.1.23"], existingHubUrl: "127.0.0.1:7380",
  });
  expect(r.joinSelf).toBe(true);
  expect(r.cursorHubUrl).toBe("127.0.0.1:7380");
  expect(r.webviewOrigin).toBe("127.0.0.1:7380");
  expect(r.overwriteCursorHubUrl).toBe(false);
});

test("join self with empty settings still writes loopback", () => {
  const r = resolveHubTargets({
    role: "join", parsedHost: "192.168.1.23", parsedPort: 7380,
    localShareCandidates: ["192.168.1.23"], existingHubUrl: null,
  });
  expect(r.joinSelf).toBe(true);
  expect(r.cursorHubUrl).toBe("127.0.0.1:7380");
  expect(r.overwriteCursorHubUrl).toBe(true);
});
