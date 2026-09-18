import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { UI_PREFS_DEFAULTS, writeUiPrefs } from "../src/uiPrefs";

let s: HubServer | null = null;
afterEach(() => { s?.stop(); s = null; });

function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-prompt-snippets-api-"));
  s = createServer({ port: 0, home });
  return { home, base: `http://127.0.0.1:${s.port}`, tok: s.token };
}

describe("GET/PUT /api/prompt-snippets", () => {
  test("GET missing file → { snippets: [] }", async () => {
    const { base, tok } = start();
    const r = await fetch(`${base}/api/prompt-snippets`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ snippets: [] });
  });

  test("PUT two then GET; theme untouched", async () => {
    const { home, base, tok } = start();
    writeUiPrefs(home, { ...UI_PREFS_DEFAULTS, theme: "light" });
    const put = await fetch(`${base}/api/prompt-snippets`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ snippets: [{ title: "审", body: "按清单 review" }] }),
    });
    expect(put.status).toBe(200);
    const body = await put.json() as { snippets: { id: string; title: string; body: string }[] };
    expect(body.snippets).toHaveLength(1);
    expect(body.snippets[0]!.id).toMatch(/^[a-z0-9-]{8,64}$/);
    const prefs = await (await fetch(`${base}/api/ui-prefs`, { headers: { Authorization: `Bearer ${tok}` } })).json();
    expect(prefs.theme).toBe("light");
    expect(prefs.promptSnippets).toHaveLength(1);
  });

  test("PUT 31 → 400 SNIPPET_LIMIT and file unchanged", async () => {
    const { home, base, tok } = start();
    writeUiPrefs(home, UI_PREFS_DEFAULTS);
    const snippets = Array.from({ length: 31 }, (_, i) => ({ title: `t${i}`, body: "b" }));
    const r = await fetch(`${base}/api/prompt-snippets`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ snippets }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "SNIPPET_LIMIT" });
    const get = await fetch(`${base}/api/prompt-snippets`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(await get.json()).toEqual({ snippets: [] });
  });

  test("PUT empty title → 400 SNIPPET_INVALID", async () => {
    const { base, tok } = start();
    const r = await fetch(`${base}/api/prompt-snippets`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ snippets: [{ title: " ", body: "x" }] }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "SNIPPET_INVALID" });
  });

  test("GET corrupt prefs → 503 READ_FAIL", async () => {
    const { home, base, tok } = start();
    writeFileSync(join(home, "ui-prefs.json"), "{bad", { mode: 0o600 });
    const r = await fetch(`${base}/api/prompt-snippets`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "READ_FAIL" });
  });
});
