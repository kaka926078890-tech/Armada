import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { REQUIRED_EXTENSION_VERSION } from "../web/src/boardState";

let s: HubServer | null = null;
afterEach(() => { s?.stop(); s = null; });

function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-cursor-reload-api-"));
  s = createServer({ port: 0, home });
  return { home, base: `http://127.0.0.1:${s.port}`, tok: s.token };
}

describe("GET/POST /api/cursor-reload", () => {
  test("GET missing file is not needed", async () => {
    const { base, tok } = start();
    const r = await fetch(`${base}/api/cursor-reload`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ pending: null, needed: false });
  });

  test("POST when-idle writes the file; skip clears it", async () => {
    const { home, base, tok } = start();
    const put = await fetch(`${base}/api/cursor-reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "when-idle" }),
    });
    expect(put.status).toBe(200);
    const body = await put.json() as { pending: { action: string; vsix: string }; needed: boolean };
    expect(body.pending.action).toBe("when-idle");
    expect(body.pending.vsix).toBe(REQUIRED_EXTENSION_VERSION);
    expect(body.needed).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "pending-reload.json"), "utf8")).action).toBe("when-idle");

    const skip = await fetch(`${base}/api/cursor-reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "skip" }),
    });
    expect(skip.status).toBe(200);
    expect(await skip.json()).toEqual({ pending: null, needed: false });
  });

  test("POST junk action is 400 INVALID", async () => {
    const { base, tok } = start();
    const r = await fetch(`${base}/api/cursor-reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "later" }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "INVALID" });
  });
});
