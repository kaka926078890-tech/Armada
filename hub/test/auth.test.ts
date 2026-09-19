import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { loadToken, authMiddleware, ARMADA_HOME } from "../src/auth";
import { createServer, type HubServer } from "../src/index";

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
  app.post("/api/x", (c) => c.json({ ok: true }));
  app.get("/api/events", (c) => c.json({ ok: true }));
  app.get("/api/runs/:id/stream", (c) => c.json({ ok: true }));
  app.get("/api/audit/export", (c) => c.json({ ok: true }));
  app.post("/api/blobs", (c) => c.json({ ok: true }));

  test("rejects missing token with 401", async () => {
    const r = await app.request("/api/x");
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "unauthorized" });
  });
  test("accepts Bearer header", async () => {
    const r = await app.request("/api/x", { headers: { Authorization: "Bearer tok123" } });
    expect(r.status).toBe(200);
  });
  test("accepts ?token= on GET SSE, events, and audit export", async () => {
    const events = await app.request("/api/events?token=tok123");
    expect(events.status).toBe(200);
    const stream = await app.request("/api/runs/run-1/stream?token=tok123");
    expect(stream.status).toBe(200);
    const exported = await app.request("/api/audit/export?token=tok123");
    expect(exported.status).toBe(200);
  });
  test("rejects ?token= on GET paths outside the allowlist", async () => {
    const r = await app.request("/api/x?token=tok123");
    expect(r.status).toBe(401);
  });
  test("rejects ?token= on POST even for allowlisted GET paths", async () => {
    const r = await app.request("/api/blobs?token=tok123", { method: "POST" });
    expect(r.status).toBe(401);
  });
  test("rejects ?token= on generic POST", async () => {
    const r = await app.request("/api/x?token=tok123", { method: "POST" });
    expect(r.status).toBe(401);
  });
  test("rejects wrong token", async () => {
    const r = await app.request("/api/x?token=nope");
    expect(r.status).toBe(401);
  });
});

describe("hub query token writes", () => {
  test("POST /api/blobs?token= without Authorization is 401", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-auth-blob-"));
    const hub: HubServer = createServer({ port: 0, home });
    try {
      const fd = new FormData();
      fd.append("file", new File(["<html><script>alert(1)</script></html>"], "x.html", { type: "text/html" }));
      const r = await fetch(`http://127.0.0.1:${hub.port}/api/blobs?token=${hub.token}`, { method: "POST", body: fd });
      expect(r.status).toBe(401);
    } finally {
      hub.stop();
    }
  });

  test("GET /api/events?token= still opens SSE", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-auth-sse-"));
    const hub: HubServer = createServer({ port: 0, home });
    const ac = new AbortController();
    try {
      const r = await fetch(`http://127.0.0.1:${hub.port}/api/events?token=${hub.token}`, { signal: ac.signal });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
    } finally {
      ac.abort();
      hub.stop();
    }
  });
});

describe("audit export UI", () => {
  test("RunDetail fetches export with Bearer and does not put token in the URL", () => {
    const src = readFileSync(join(import.meta.dir, "../web/src/components/RunDetail.tsx"), "utf8");
    expect(src).not.toMatch(/\/api\/audit\/export\?token=/);
    expect(src).toMatch(/fetch\(\s*["']\/api\/audit\/export["']/);
    expect(src).toMatch(/authorization:\s*`Bearer \$\{getToken\(\)\}`/);
    expect(src).toMatch(/\.blob\(\)/);
  });
});
