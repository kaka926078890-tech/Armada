import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildApnsRequest, createApnsSender, isUnregistered, loadApnsFromEnv, applyHomeEnv, payloadTooLarge, signApnsJwt } from "../src/apns";

test("applyHomeEnv fills blank keys from RELAY_HOME/env", () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-apns-"));
  writeFileSync(join(dir, "env"), "RELAY_APNS_KEY_ID=797HGTVDN8\nRELAY_APNS_TEAM_ID=LW2A4J4KKG\n");
  const env: NodeJS.ProcessEnv = { RELAY_APNS_KEY_ID: "" };
  applyHomeEnv(dir, env);
  expect(env.RELAY_APNS_KEY_ID).toBe("797HGTVDN8");
  expect(env.RELAY_APNS_TEAM_ID).toBe("LW2A4J4KKG");
  env.RELAY_APNS_KEY_ID = "keep";
  applyHomeEnv(dir, env);
  expect(env.RELAY_APNS_KEY_ID).toBe("keep");
});

test("loadApnsFromEnv requires all three", () => {
  expect(loadApnsFromEnv({})).toBeNull();
  expect(loadApnsFromEnv({ RELAY_APNS_KEY_PATH: "/x", RELAY_APNS_KEY_ID: "k" })).toBeNull();
  expect(loadApnsFromEnv({
    RELAY_APNS_KEY_PATH: "/x", RELAY_APNS_KEY_ID: "k", RELAY_APNS_TEAM_ID: "LW2A4J4KKG",
  })).toMatchObject({ keyPath: "/x", keyId: "k", teamId: "LW2A4J4KKG", bundleId: "app.armada.remote" });
});

test("buildApnsRequest has collapse-id, no finalText", () => {
  const req = buildApnsRequest({
    token: "a".repeat(64),
    runId: "r-1",
    edge: { kind: "completed", title: "Armada 任务完成", body: "fix the bug" },
    bundleId: "app.armada.remote",
    jwt: "jwt",
  });
  expect(req.headers["apns-topic"]).toBe("app.armada.remote");
  expect(req.headers["apns-collapse-id"]).toBe("run-r-1");
  expect(req.headers["apns-push-type"]).toBe("alert");
  const parsed = JSON.parse(req.body);
  expect(parsed.finalText).toBeUndefined();
  expect(parsed.runId).toBe("r-1");
  expect(parsed.kind).toBe("completed");
  expect(parsed.aps.alert.title).toBe("Armada 任务完成");
  expect(payloadTooLarge(req.body)).toBe(false);
});

test("signApnsJwt is three ES256 segments", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwt = signApnsJwt(pem, "KEYID", "LW2A4J4KKG", 1);
  expect(jwt.split(".").length).toBe(3);
});

test("sender is no-op without a key file", async () => {
  const s = createApnsSender(null);
  expect(s.enabled).toBe(false);
  expect(await s.send("a".repeat(64), "r-1", { kind: "completed", title: "t", body: "b" })).toBe("disabled");
});

test("sender posts mock 200 and treats 410 as unregistered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-apns-"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyPath = join(dir, "key.p8");
  writeFileSync(keyPath, pem);
  const calls: string[] = [];
  const s = createApnsSender({
    keyPath, keyId: "KEYID", teamId: "LW2A4J4KKG",
    retryDelays: [],
    post: async (url, headers, body) => {
      calls.push(body);
      expect(url).toContain("/3/device/");
      expect(headers["apns-topic"]).toBe("app.armada.remote");
      expect(JSON.parse(body).finalText).toBeUndefined();
      return { status: 200 };
    },
  });
  expect(s.enabled).toBe(true);
  expect(await s.send("a".repeat(64), "r-1", { kind: "ask", title: "Armada 需要你处理", body: "Q" })).toBe("ok");
  expect(calls).toHaveLength(1);

  const gone = createApnsSender({
    keyPath, keyId: "KEYID", teamId: "LW2A4J4KKG",
    retryDelays: [],
    post: async () => ({ status: 410, reason: "Unregistered" }),
  });
  expect(await gone.send("b".repeat(64), "r-1", { kind: "completed", title: "t", body: "b" })).toBe("unregistered");
  expect(isUnregistered(400, "BadDeviceToken")).toBe(true);
});
