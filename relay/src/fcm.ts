import { createSign } from "crypto";
import { existsSync, readFileSync } from "fs";
import type { NotifyEdge } from "./notifyEdge";

export type FcmPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; errorStatus?: string }>;

export type FcmConfig = {
  serviceAccountPath: string;
  projectId?: string;
  post?: FcmPost;
  retryDelays?: number[];
  accessToken?: string;
};

const FCM_TOKEN_RE = /^[A-Za-z0-9_:\-.]{32,4096}$/;
const OAUTH_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_TTL_MS = 50 * 60 * 1000;

export function isFcmToken(token: string): boolean {
  return FCM_TOKEN_RE.test(token);
}

export function loadFcmFromEnv(env: NodeJS.ProcessEnv = process.env): FcmConfig | null {
  const serviceAccountPath = env.RELAY_FCM_SERVICE_ACCOUNT_PATH?.trim();
  if (!serviceAccountPath) return null;
  const projectId = env.RELAY_FCM_PROJECT_ID?.trim();
  return { serviceAccountPath, projectId: projectId || undefined };
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function buildFcmRequest(opts: {
  token: string;
  runId: string;
  edge: NotifyEdge;
  projectId: string;
  accessToken: string;
}): { url: string; headers: Record<string, string>; body: string } {
  const collapse = `run-${opts.runId}`.slice(0, 64);
  const body = JSON.stringify({
    message: {
      token: opts.token,
      notification: { title: opts.edge.title, body: opts.edge.body },
      data: { runId: opts.runId, kind: opts.edge.kind },
      android: {
        priority: "HIGH",
        collapse_key: collapse,
        notification: {
          channel_id: "armada.alerts",
          notification_count: 1,
        },
      },
    },
  });
  return {
    url: `https://fcm.googleapis.com/v1/projects/${opts.projectId}/messages:send`,
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      "content-type": "application/json",
    },
    body,
  };
}

export function isFcmUnregistered(status: number, errorStatus?: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return errorStatus === "UNREGISTERED" || errorStatus === "NOT_FOUND" || errorStatus === "INVALID_ARGUMENT";
}

type ServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

function readAccount(path: string): ServiceAccount | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as ServiceAccount;
    if (!j.private_key || !j.client_email) return null;
    return j;
  } catch {
    return null;
  }
}

function signSaJwt(email: string, pem: string, iat = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: email,
    sub: email,
    aud: OAUTH_URL,
    iat,
    exp: iat + 3600,
    scope: SCOPE,
  }));
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  return `${data}.${b64url(signer.sign(pem))}`;
}

async function defaultFcmPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; errorStatus?: string }> {
  const res = await fetch(url, { method: "POST", headers, body });
  let errorStatus: string | undefined;
  try {
    const j = await res.json() as { error?: { status?: string } };
    if (typeof j.error?.status === "string") errorStatus = j.error.status;
  } catch { /* empty */ }
  return { status: res.status, errorStatus };
}

export type FcmSendResult = "ok" | "unregistered" | "disabled" | "fail";

export function createFcmSender(cfg: FcmConfig | null): {
  enabled: boolean;
  send: (token: string, runId: string, edge: NotifyEdge) => Promise<FcmSendResult>;
} {
  if (!cfg?.serviceAccountPath || !existsSync(cfg.serviceAccountPath)) {
    return { enabled: false, send: async () => "disabled" };
  }
  const account = readAccount(cfg.serviceAccountPath);
  const projectId = cfg.projectId || account?.project_id;
  if (!account || !projectId) {
    return { enabled: false, send: async () => "disabled" };
  }
  const post = cfg.post ?? defaultFcmPost;
  const delays = cfg.retryDelays ?? [2000, 8000, 30000];
  let cached = cfg.accessToken ?? "";
  let cachedAt = cfg.accessToken ? Date.now() : 0;

  const token = async (): Promise<string> => {
    const now = Date.now();
    if (cached && now - cachedAt < TOKEN_TTL_MS) return cached;
    const jwt = signSaJwt(account.client_email!, account.private_key!);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString();
    const res = await fetch(OAUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await res.json().catch(() => null) as { access_token?: string } | null;
    if (res.status !== 200 || !j?.access_token) throw new Error("fcm oauth");
    cached = j.access_token;
    cachedAt = now;
    return cached;
  };

  return {
    enabled: true,
    async send(deviceToken, runId, edge) {
      let last: FcmSendResult = "fail";
      const tries = Math.max(1, delays.length || 1);
      for (let i = 0; i < tries; i++) {
        try {
          const access = cfg.accessToken ?? await token();
          const req = buildFcmRequest({ token: deviceToken, runId, edge, projectId, accessToken: access });
          const res = await post(req.url, req.headers, req.body);
          if (res.status === 200) return "ok";
          if (isFcmUnregistered(res.status, res.errorStatus)) return "unregistered";
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
