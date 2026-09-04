import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { UI_PREFS_DEFAULTS, writeUiPrefs } from "../src/uiPrefs";

let s: HubServer | null = null;
afterEach(() => { s?.stop(); s = null; });

function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-prefs-api-"));
  s = createServer({ port: 0, home });
  return { home, base: `http://127.0.0.1:${s.port}`, tok: s.token };
}

describe("GET/PUT /api/ui-prefs", () => {
  test("GET missing → 200 defaults + source defaults", async () => {
    const { base, tok } = start();
    const r = await fetch(`${base}/api/ui-prefs`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ...UI_PREFS_DEFAULTS, source: "defaults" });
  });

  test("GET corrupt → 503 READ_FAIL", async () => {
    const { home, base, tok } = start();
    writeFileSync(join(home, "ui-prefs.json"), "{bad", { mode: 0o600 });
    const r = await fetch(`${base}/api/ui-prefs`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "READ_FAIL" });
  });

  test("PUT merge theme keeps readRuns; GET then source file", async () => {
    const { home, base, tok } = start();
    writeUiPrefs(home, { ...UI_PREFS_DEFAULTS, readRuns: { r1: 42 } });
    const put = await fetch(`${base}/api/ui-prefs`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ theme: "light" }),
    });
    expect(put.status).toBe(200);
    const body = await put.json() as Record<string, unknown>;
    expect(body.theme).toBe("light");
    expect(body.readRuns).toEqual({ r1: 42 });
    expect(body.source).toBeUndefined();
    const get = await fetch(`${base}/api/ui-prefs`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(await get.json()).toMatchObject({ theme: "light", source: "file", readRuns: { r1: 42 } });
  });

  test("PUT non-object → 400", async () => {
    const { base, tok } = start();
    const r = await fetch(`${base}/api/ui-prefs`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify("x"),
    });
    expect(r.status).toBe(400);
  });
});
