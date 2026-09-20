import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HEX64 = /^[a-f0-9]{64}$/;

export function adminTokenPath(home: string): string {
  return join(home, "admin-token");
}

export function adminTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function resolveAdminToken(home: string, provided?: string | null): {
  token: string;
  persisted: boolean;
  path: string;
} {
  const path = adminTokenPath(home);
  const fromEnv = typeof provided === "string" ? provided.trim() : "";
  if (fromEnv) return { token: fromEnv, persisted: false, path };
  mkdirSync(home, { recursive: true });
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (HEX64.test(existing)) return { token: existing, persisted: true, path };
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  return { token, persisted: true, path };
}

export function adminTokenLogLine(resolved: { token: string; persisted: boolean; path: string }): string | null {
  if (!resolved.persisted) return null;
  return `armada-relay admin token fingerprint=${adminTokenFingerprint(resolved.token)} file=${resolved.path}`;
}
