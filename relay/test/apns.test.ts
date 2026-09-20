import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { buildApnsRequest, createApnsSender, isUnregistered, loadApnsFromEnv, applyHomeEnv, payloadTooLarge, signApnsJwt, apnsHost, normalizeApnsEnvironment } from "../src/apns";
import { openRelayDb } from "../src/db";

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
  expect(req.url).toContain("https://api.push.apple.com/3/device/");
  const parsed = JSON.parse(req.body);
  expect(parsed.finalText).toBeUndefined();
  expect(parsed.runId).toBe("r-1");
  expect(parsed.kind).toBe("completed");
  expect(parsed.aps.alert.title).toBe("Armada 任务完成");
  expect(parsed.aps.badge).toBeUndefined();
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

test("Rel-M6 sandbox tokens hit api.sandbox.push.apple.com", async () => {
  expect(normalizeApnsEnvironment("sandbox")).toBe("sandbox");
  expect(normalizeApnsEnvironment("production")).toBe("production");
  expect(normalizeApnsEnvironment("prod")).toBeNull();
  expect(apnsHost("sandbox")).toBe("https://api.sandbox.push.apple.com");
  expect(apnsHost("production")).toBe("https://api.push.apple.com");
  const req = buildApnsRequest({
    token: "a".repeat(64),
    runId: "r-1",
    edge: { kind: "completed", title: "t", body: "b" },
    bundleId: "app.armada.remote",
    jwt: "jwt",
    environment: "sandbox",
  });
  expect(req.url).toBe(`https://api.sandbox.push.apple.com/3/device/${"a".repeat(64)}`);

  const dir = mkdtempSync(join(tmpdir(), "armada-apns-"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyPath = join(dir, "key.p8");
  writeFileSync(keyPath, pem);
  const urls: string[] = [];
  const s = createApnsSender({
    keyPath, keyId: "KEYID", teamId: "LW2A4J4KKG",
    retryDelays: [],
    post: async (url) => {
      urls.push(url);
      return { status: 200 };
    },
  });
  expect(await s.send("c".repeat(64), "r-1", { kind: "ask", title: "t", body: "b" }, "sandbox")).toBe("ok");
  expect(urls[0]).toContain("https://api.sandbox.push.apple.com/3/device/");
});

test("openRelayDb migrates production-only CHECK so sandbox tokens can persist", () => {
  const home = mkdtempSync(join(tmpdir(), "armada-relay-db-"));
  const raw = new Database(join(home, "relay.db"));
  raw.exec(`
    CREATE TABLE fleets (
      id TEXT PRIMARY KEY,
      hub_secret TEXT NOT NULL UNIQUE,
      operator_token TEXT NOT NULL UNIQUE,
      hub_online INTEGER NOT NULL DEFAULT 0,
      workspaces TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    INSERT INTO fleets VALUES ('fleet-1','sec','op',0,'[]',1);
    CREATE TABLE push_tokens (
      token TEXT NOT NULL,
      fleet_id TEXT NOT NULL REFERENCES fleets(id),
      environment TEXT NOT NULL CHECK (environment = 'production'),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (fleet_id, token)
    );
    INSERT INTO push_tokens VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','fleet-1','production',1);
  `);
  raw.close();
  const db = openRelayDb(home);
  db.query(`INSERT INTO push_tokens (token, fleet_id, environment, updated_at, platform) VALUES (?1,?2,'sandbox',2,'apns')`)
    .run("b".repeat(64), "fleet-1");
  const rows = db.query("SELECT environment FROM push_tokens ORDER BY token").all() as { environment: string }[];
  expect(rows.map((r) => r.environment)).toEqual(["production", "sandbox"]);
});
