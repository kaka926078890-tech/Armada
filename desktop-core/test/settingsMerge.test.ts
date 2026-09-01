import { describe, expect, test } from "bun:test";
import { mergeArmadaSettings, shouldWriteCursorSettings } from "../src/settingsMerge";

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
