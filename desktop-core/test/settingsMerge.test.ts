import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { mergeArmadaSettings, shouldWriteCursorSettings, shouldWriteOwnedCursorHubUrl } from "../src/settingsMerge";

test("inserts into empty and preserves unrelated keys", () => {
  const { json, changed } = mergeArmadaSettings('{\n  "editor.fontSize": 14\n}\n', "127.0.0.1:7380", "ab");
  expect(changed).toBe(true);
  const o = JSON.parse(json);
  expect(o["editor.fontSize"]).toBe(14);
  expect(o["armada.hubUrl"]).toBe("127.0.0.1:7380");
  expect(o["armada.token"]).toBe("ab");
  expect(o["armada.cdpPort"]).toBeUndefined();
});

test("no-op when same values", () => {
  const raw = JSON.stringify({ "armada.hubUrl": "127.0.0.1:7380", "armada.token": "ab" }, null, 2);
  expect(mergeArmadaSettings(raw, "127.0.0.1:7380", "ab").changed).toBe(false);
});

test("empty file", () => {
  const { json } = mergeArmadaSettings("", "a:7380", "t");
  expect(JSON.parse(json)["armada.hubUrl"]).toBe("a:7380");
});

test("join-self overwrite false skips write when both keys already equal", () => {
  expect(shouldWriteCursorSettings({
    overwriteCursorHubUrl: false,
    existingHubUrl: "127.0.0.1:7380",
    existingToken: "ab",
    hubUrl: "127.0.0.1:7380",
    token: "ab",
  })).toBe(false);
});

test("join-self overwrite false still writes when token differs", () => {
  expect(shouldWriteCursorSettings({
    overwriteCursorHubUrl: false,
    existingHubUrl: "127.0.0.1:7380",
    existingToken: "old",
    hubUrl: "127.0.0.1:7380",
    token: "new",
  })).toBe(true);
});

test("join-self overwrite false keeps loopback even if LAN hubUrl is passed", () => {
  expect(shouldWriteCursorSettings({
    overwriteCursorHubUrl: false,
    existingHubUrl: "127.0.0.1:7380",
    existingToken: "ab",
    hubUrl: "192.168.1.23:7380",
    token: "ab",
  })).toBe(false);
});

test("ensure rewrites Cursor hubUrl when it differs from target even if attachCursor is false", () => {
  expect(shouldWriteOwnedCursorHubUrl({ attachCursor: false, overwriteCursorHubUrl: true })).toBe(true);
  expect(shouldWriteOwnedCursorHubUrl({ attachCursor: false, overwriteCursorHubUrl: false })).toBe(false);
  expect(shouldWriteOwnedCursorHubUrl({ attachCursor: true, overwriteCursorHubUrl: true })).toBe(true);
});

test("finish_create does not skip hubUrl write just because attach_cursor is false", () => {
  const hub = readFileSync(join(import.meta.dir, "../../desktop/src-tauri/src/hub.rs"), "utf8");
  const start = hub.indexOf("fn finish_create(");
  expect(start).toBeGreaterThanOrEqual(0);
  const body = hub.slice(start, hub.indexOf("fn apply_owned(", start));
  expect(body).toContain("should_write_owned_cursor_hub_url");
  expect(body).toContain("apply_cursor_settings");
  expect(body).toContain("install_vsix");
});
