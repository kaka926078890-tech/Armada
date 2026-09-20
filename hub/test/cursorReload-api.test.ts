import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { REQUIRED_EXTENSION_VERSION } from "../web/src/boardState";
import { vsixFileName, vsixPackMissingNotice } from "../../desktop-core/src/cursorReload";

let s: HubServer | null = null;
afterEach(() => { s?.stop(); s = null; });

function packDir(home: string, present: boolean): string {
  const dir = join(home, "vsix-pack");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, vsixFileName(REQUIRED_EXTENSION_VERSION));
  if (present) writeFileSync(file, "pk");
  return dir;
}

function start(opts: { packPresent?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "armada-cursor-reload-api-"));
  const present = opts.packPresent !== false;
  s = createServer({ port: 0, home, vsixSearchDirs: [packDir(home, present)] });
  return { home, base: `http://127.0.0.1:${s.port}`, tok: s.token };
}

describe("GET/POST /api/cursor-reload", () => {
  test("GET missing file is not needed", async () => {
    const { base, tok } = start();
    const r = await fetch(`${base}/api/cursor-reload`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      pending: null, needed: false, neededMachineIds: [],
      required: REQUIRED_EXTENSION_VERSION, packPresent: true, notice: null,
    });
  });

  test("GET without the vsix pack tells the operator to pack; POST now is 409", async () => {
    const { home, base, tok } = start({ packPresent: false });
    const get = await fetch(`${base}/api/cursor-reload`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      pending: null, needed: false, neededMachineIds: [],
      required: REQUIRED_EXTENSION_VERSION, packPresent: false,
      notice: vsixPackMissingNotice(REQUIRED_EXTENSION_VERSION),
    });
    const put = await fetch(`${base}/api/cursor-reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "now" }),
    });
    expect(put.status).toBe(409);
    expect(await put.json()).toEqual({
      error: "PACK_MISSING",
      required: REQUIRED_EXTENSION_VERSION,
      notice: vsixPackMissingNotice(REQUIRED_EXTENSION_VERSION),
    });
    expect(() => readFileSync(join(home, "pending-reload.json"), "utf8")).toThrow();
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
    expect(await skip.json()).toMatchObject({ pending: null, needed: false, neededMachineIds: [] });
  });

  test("needed ignores offline stale extension versions", async () => {
    const { base, tok } = start();
    s!.registry.upsertMachine({
      id: "m-old", name: "Old", os: "darwin", extensionVersion: "0.4.18", openWorkspaces: [],
    });
    s!.registry.markOffline("m-old");
    s!.registry.upsertMachine({
      id: "m-mac", name: "Mac", os: "darwin", extensionVersion: REQUIRED_EXTENSION_VERSION, openWorkspaces: [],
    });
    await fetch(`${base}/api/cursor-reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "when-idle" }),
    });
    const get = await fetch(`${base}/api/cursor-reload`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(await get.json()).toMatchObject({ needed: false, neededMachineIds: [] });
  });

  test("neededMachineIds omits an online machine already on the required vsix", async () => {
    const { base, tok } = start();
    s!.registry.upsertMachine({
      id: "m-mac", name: "Mac", os: "darwin", extensionVersion: REQUIRED_EXTENSION_VERSION, openWorkspaces: [],
    });
    s!.registry.upsertMachine({
      id: "m-win", name: "Win", os: "win32", extensionVersion: "0.4.18", openWorkspaces: [],
    });
    await fetch(`${base}/api/cursor-reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "when-idle" }),
    });
    const get = await fetch(`${base}/api/cursor-reload`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(await get.json()).toMatchObject({ needed: true, neededMachineIds: ["m-win"] });
  });

  test("POST pushes ext.cursorReload on connected sockets", async () => {
    const { base, tok } = start();
    const sent: unknown[] = [];
    const ws = { data: { registered: false }, send(raw: string) { sent.push(JSON.parse(raw)); }, close() {} };
    s!.registry.onRegister(ws, {
      machineId: "m-1", windowId: "w-1", name: "Mac", os: "darwin",
      extensionVersion: "0.4.26", openWorkspaces: ["/ws"],
    });
    sent.length = 0;
    const put = await fetch(`${base}/api/cursor-reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "now", machineId: "m-1" }),
    });
    expect(put.status).toBe(200);
    expect(sent.some((m) => (m as { type?: string }).type === "ext.cursorReload")).toBe(true);
  });

  test("POST unknown machineId is 404", async () => {
    const { base, tok } = start();
    const r = await fetch(`${base}/api/cursor-reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "now", machineId: "nope" }),
    });
    expect(r.status).toBe(404);
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
