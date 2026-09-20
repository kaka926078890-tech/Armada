import { createPrivateKey, sign } from "crypto";
import { existsSync, readFileSync } from "fs";
import { connect } from "http2";
import { join } from "path";
import type { NotifyEdge } from "./notifyEdge";

export type ApnsPost = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; reason?: string }>;

export type ApnsConfig = {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId?: string;
  post?: ApnsPost;
  retryDelays?: number[];
};

const JWT_TTL_MS = 50 * 60 * 1000;
const HOST = "https://api.push.apple.com";

export function applyHomeEnv(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const p = join(home, "env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    const cur = env[key];
    if (cur == null || cur === "") env[key] = line.slice(eq + 1).trim();
  }
}

export function loadApnsFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const keyPath = env.RELAY_APNS_KEY_PATH?.trim();
  const keyId = env.RELAY_APNS_KEY_ID?.trim();
  const teamId = env.RELAY_APNS_TEAM_ID?.trim();
  if (!keyPath || !keyId || !teamId) return null;
  return {
    keyPath,
    keyId,
    teamId,
    bundleId: env.RELAY_APNS_BUNDLE_ID?.trim() || "app.armada.remote",
  };
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signApnsJwt(pem: string, keyId: string, teamId: string, iat = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat }));
  const data = `${header}.${payload}`;
  const sig = sign("sha256", Buffer.from(data), {
    key: createPrivateKey(pem),
    dsaEncoding: "ieee-p1363",
  });
  return `${data}.${b64url(sig)}`;
}

export function buildApnsRequest(opts: {
  token: string;
  runId: string;
  edge: NotifyEdge;
  bundleId: string;
  jwt: string;
}): { url: string; headers: Record<string, string>; body: string } {
  const body = JSON.stringify({
    aps: {
      alert: { title: opts.edge.title, body: opts.edge.body },
      sound: "default",
    },
    runId: opts.runId,
    kind: opts.edge.kind,
  });
  return {
    url: `${HOST}/3/device/${opts.token}`,
    headers: {
      authorization: `bearer ${opts.jwt}`,
      "apns-topic": opts.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": `run-${opts.runId}`.slice(0, 64),
    },
    body,
  };
}

export function payloadTooLarge(body: string): boolean {
  return Buffer.byteLength(body, "utf8") >= 4096;
}

export function isUnregistered(status: number, reason?: string): boolean {
  if (status === 410) return true;
  return status === 400 && (reason === "Unregistered" || reason === "BadDeviceToken");
}

export async function defaultApnsPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; reason?: string }> {
  const u = new URL(url);
  return await new Promise((resolve, reject) => {
    const client = connect(u.origin);
    const req = client.request({
      ":method": "POST",
      ":path": u.pathname,
      authorization: headers.authorization,
      "apns-topic": headers["apns-topic"],
      "apns-push-type": headers["apns-push-type"],
      "apns-priority": headers["apns-priority"],
      "apns-collapse-id": headers["apns-collapse-id"],
      "content-type": "application/json",
    });
    let status = 0;
    let chunks = "";
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.on("data", (c) => { chunks += String(c); });
    req.on("error", reject);
    req.on("end", () => {
      client.close();
      let reason: string | undefined;
      try {
        const j = JSON.parse(chunks) as { reason?: string };
        if (typeof j.reason === "string") reason = j.reason;
      } catch { /* empty 200 */ }
      resolve({ status, reason });
    });
    client.on("error", reject);
    req.end(body);
  });
}

export type ApnsSendResult = "ok" | "unregistered" | "disabled" | "fail" | "too_large";

export function createApnsSender(cfg: ApnsConfig | null): {
  enabled: boolean;
  send: (token: string, runId: string, edge: NotifyEdge) => Promise<ApnsSendResult>;
} {
  if (!cfg?.keyPath || !cfg.keyId || !cfg.teamId || !existsSync(cfg.keyPath)) {
    return { enabled: false, send: async () => "disabled" };
  }
  const pem = readFileSync(cfg.keyPath, "utf8");
  const bundleId = cfg.bundleId || "app.armada.remote";
  const post = cfg.post ?? defaultApnsPost;
  const delays = cfg.retryDelays ?? [2000, 8000, 30000];
  let jwt = "";
  let jwtAt = 0;

  const tokenJwt = () => {
    const now = Date.now();
    if (!jwt || now - jwtAt > JWT_TTL_MS) {
      jwt = signApnsJwt(pem, cfg.keyId, cfg.teamId);
      jwtAt = now;
    }
    return jwt;
  };

  const sendOnce = async (token: string, runId: string, edge: NotifyEdge, forceRefreshJwt = false): Promise<{ status: number; reason?: string; body: string }> => {
    if (forceRefreshJwt) {
      jwt = "";
      jwtAt = 0;
    }
    const req = buildApnsRequest({ token, runId, edge, bundleId, jwt: tokenJwt() });
    if (payloadTooLarge(req.body)) return { status: 413, reason: "PayloadTooLarge", body: req.body };
    const res = await post(req.url, req.headers, req.body);
    return { ...res, body: req.body };
  };

  return {
    enabled: true,
    async send(token, runId, edge) {
      let last: ApnsSendResult = "fail";
      const tries = Math.max(1, delays.length || 1);
      for (let i = 0; i < tries; i++) {
        try {
          const res = await sendOnce(token, runId, edge, false);
          if (res.status === 200) return "ok";
          if (res.status === 413) return "too_large";
          if (isUnregistered(res.status, res.reason)) return "unregistered";
          if (res.status === 403 && res.reason === "ExpiredProviderToken") {
            const again = await sendOnce(token, runId, edge, true);
            if (again.status === 200) return "ok";
            if (isUnregistered(again.status, again.reason)) return "unregistered";
          }
          last = "fail";
        } catch {
          last = "fail";
        }
        if (i < tries - 1 && delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
      }
      return last;
    },
  };
}
