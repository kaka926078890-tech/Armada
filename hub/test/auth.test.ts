import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { loadToken, authMiddleware, ARMADA_HOME } from "../src/auth";

function tmpHome() { return mkdtempSync(join(tmpdir(), "armada-auth-")); }

describe("loadToken", () => {
  test("generates 64-char hex token and persists with mode 600", () => {
    const home = tmpHome();
    const t = loadToken(home);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(home, "token"))).toBe(true);
    expect((statSync(join(home, "token")).mode & 0o777).toString(8)).toBe("600");
  });
  test("reloads same token on second call", () => {
    const home = tmpHome();
    expect(loadToken(home)).toBe(loadToken(home));
  });
});

describe("ARMADA_HOME", () => {
  test("prefers explicit arg, then env, then ~/.armada", () => {
    expect(ARMADA_HOME("/tmp/x")).toBe("/tmp/x");
    process.env.ARMADA_HUB_HOME = "/tmp/env-home";
    expect(ARMADA_HOME()).toBe("/tmp/env-home");
    delete process.env.ARMADA_HUB_HOME;
    expect(ARMADA_HOME()).toBe(join(process.env.HOME!, ".armada"));
  });
});

describe("authMiddleware", () => {
  const app = new Hono();
  app.use("/api/*", authMiddleware("tok123"));
  app.get("/api/x", (c) => c.json({ ok: true }));

  test("rejects missing token with 401", async () => {
    const r = await app.request("/api/x");
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "unauthorized" });
  });
  test("accepts Bearer header", async () => {
    const r = await app.request("/api/x", { headers: { Authorization: "Bearer tok123" } });
    expect(r.status).toBe(200);
  });
  test("accepts ?token= query (for SSE)", async () => {
    const r = await app.request("/api/x?token=tok123");
    expect(r.status).toBe(200);
  });
  test("rejects wrong token", async () => {
    const r = await app.request("/api/x?token=nope");
    expect(r.status).toBe(401);
  });
});
