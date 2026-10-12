import { describe, expect, test } from "bun:test";
import {
  desktopPlaceholderOk,
  relayDesktopHttp,
  shouldClearDesktopHub,
  shouldPersistDesktopJoin,
} from "../src/desktopRelay";
import { startDesktopLoopback } from "../src/desktopLoopback";

describe("desktop relay join", () => {
  test("drops only the placeholder query and keeps the board query", () => {
    const url = relayDesktopHttp(
      "https://relay.example.com",
      "/api/runs",
      "?archived=1&limit=5&fromEnd=1&path=docs%2Fa.md&token=placeholder&desktop=1",
    );
    expect(url).toBe("https://relay.example.com/desktop/api/runs?archived=1&limit=5&fromEnd=1&path=docs%2Fa.md");
    expect(url).not.toContain("placeholder");
    expect(shouldPersistDesktopJoin(200)).toBe(true);
    expect(shouldPersistDesktopJoin(403)).toBe(false);
    expect(shouldPersistDesktopJoin(503)).toBe(false);
    expect(shouldClearDesktopHub("127.0.0.1:7391", "127.0.0.1:7391")).toBe(true);
    expect(shouldClearDesktopHub("192.168.1.196:7380", "127.0.0.1:7391")).toBe(false);
  });

  test("forwards a bearer-only /api/machines call and drops any other bearer", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const loop = startDesktopLoopback({
      relay: "https://relay.example.com",
      fleet: "fleet-abc12",
      desktopToken: "d".repeat(64),
      placeholder: "p".repeat(64),
      port: 0,
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), authorization: headers.get("authorization") });
        return new Response(JSON.stringify({ machines: [] }), { status: 200 });
      },
    });
    const ok = await fetch(`http://127.0.0.1:${loop.port}/api/machines`, {
      headers: { authorization: `Bearer ${"p".repeat(64)}` },
    });
    expect(ok.status).toBe(200);
    expect(seen[0]?.url).toBe("https://relay.example.com/desktop/api/machines");
    expect(seen[0]?.authorization).toBe(`Bearer ${"d".repeat(64)}`);
    const denied = await fetch(`http://127.0.0.1:${loop.port}/api/machines`, {
      headers: { authorization: "Bearer someone-else" },
    });
    expect(denied.status).toBe(401);
    expect(seen).toHaveLength(1);
    const page = await fetch(`http://127.0.0.1:${loop.port}/?token=${"p".repeat(64)}&desktop=1`);
    expect(page.status).toBe(200);
    expect(seen[1]?.url).toBe("https://relay.example.com/desktop/");
    expect(desktopPlaceholderOk(`?token=${"p".repeat(64)}`, null, "p".repeat(64))).toBe(true);
    loop.stop();
  });
});
