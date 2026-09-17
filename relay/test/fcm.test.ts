import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildFcmRequest,
  createFcmSender,
  isFcmToken,
  isFcmUnregistered,
  loadFcmFromEnv,
} from "../src/fcm";

const TOKEN = "dGVzdDp0b2tlbi1mb3ItZmNt:APA91bTestToken_abc-123.xyz";

test("loadFcmFromEnv requires service account path", () => {
  expect(loadFcmFromEnv({})).toBeNull();
  expect(loadFcmFromEnv({ RELAY_FCM_SERVICE_ACCOUNT_PATH: "/x.json" })).toMatchObject({
    serviceAccountPath: "/x.json",
  });
});

test("isFcmToken accepts FCM registration tokens and rejects 64 hex", () => {
  expect(isFcmToken(TOKEN)).toBe(true);
  expect(isFcmToken("a".repeat(64))).toBe(true);
  expect(isFcmToken("zz")).toBe(false);
  expect(isFcmToken("bad token with space")).toBe(false);
});

test("buildFcmRequest has visible notification, runId, kind, no finalText", () => {
  const req = buildFcmRequest({
    token: TOKEN,
    runId: "r-1",
    edge: { kind: "completed", title: "Armada 任务完成", body: "fix the bug" },
    projectId: "armada-remote",
    accessToken: "ya29.test",
  });
  expect(req.url).toBe("https://fcm.googleapis.com/v1/projects/armada-remote/messages:send");
  expect(req.headers.authorization).toBe("Bearer ya29.test");
  const parsed = JSON.parse(req.body) as {
    message: {
      token: string;
      notification: { title: string; body: string };
      data: { runId: string; kind: string; finalText?: string };
      android: { collapse_key: string; notification: { channel_id: string } };
    };
  };
  expect(parsed.message.token).toBe(TOKEN);
  expect(parsed.message.notification.title).toBe("Armada 任务完成");
  expect(parsed.message.data.runId).toBe("r-1");
  expect(parsed.message.data.kind).toBe("completed");
  expect(parsed.message.data.finalText).toBeUndefined();
  expect(JSON.stringify(parsed)).not.toContain("finalText");
  expect(parsed.message.android.collapse_key.startsWith("run-")).toBe(true);
  expect(parsed.message.android.notification.channel_id).toBe("armada.alerts");
});

test("sender is no-op without a service account file", async () => {
  const s = createFcmSender(null);
  expect(s.enabled).toBe(false);
  expect(await s.send(TOKEN, "r-1", { kind: "completed", title: "t", body: "b" })).toBe("disabled");
});

test("sender posts mock 200 and treats UNREGISTERED as unregistered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-fcm-"));
  const path = join(dir, "sa.json");
  writeFileSync(path, JSON.stringify({
    type: "service_account",
    project_id: "armada-remote",
    client_email: "relay@armada-remote.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
  }));
  const calls: string[] = [];
  const s = createFcmSender({
    serviceAccountPath: path,
    retryDelays: [],
    accessToken: "tok",
    post: async (url, _headers, body) => {
      calls.push(body);
      expect(url).toContain("/v1/projects/armada-remote/messages:send");
      expect(JSON.parse(body).message.data.finalText).toBeUndefined();
      return { status: 200 };
    },
  });
  expect(s.enabled).toBe(true);
  expect(await s.send(TOKEN, "r-1", { kind: "ask", title: "Armada 需要你处理", body: "Q" })).toBe("ok");
  expect(calls).toHaveLength(1);

  const gone = createFcmSender({
    serviceAccountPath: path,
    retryDelays: [],
    accessToken: "tok",
    post: async () => ({ status: 404, errorStatus: "NOT_FOUND" }),
  });
  expect(await gone.send(TOKEN, "r-1", { kind: "completed", title: "t", body: "b" })).toBe("unregistered");
  expect(isFcmUnregistered(404, "NOT_FOUND")).toBe(true);
  expect(isFcmUnregistered(400, "UNREGISTERED")).toBe(true);
});
