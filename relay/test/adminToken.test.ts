import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { adminTokenFingerprint, adminTokenLogLine, adminTokenPath, resolveAdminToken } from "../src/adminToken";

describe("Rel-M8 admin token", () => {
  test("writes once, reuses the file, and never puts the secret in the log line", () => {
    const home = mkdtempSync(join(tmpdir(), "armada-admin-"));
    const first = resolveAdminToken(home);
    expect(first.persisted).toBe(true);
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(first.path)).toBe(true);
    chmodSync(first.path, 0o600);
    const second = resolveAdminToken(home);
    expect(second.token).toBe(first.token);
    expect(readFileSync(adminTokenPath(home), "utf8").trim()).toBe(first.token);

    const line = adminTokenLogLine(first);
    expect(line).toContain(`fingerprint=${adminTokenFingerprint(first.token)}`);
    expect(line).toContain(`file=${first.path}`);
    expect(line).not.toContain(first.token);
    expect(adminTokenFingerprint(first.token)).toHaveLength(12);
    expect(adminTokenFingerprint(first.token)).not.toBe(first.token.slice(0, 12));
  });

  test("provided env token is used as-is and is not persisted or logged", () => {
    const home = mkdtempSync(join(tmpdir(), "armada-admin-"));
    const env = "b".repeat(64);
    const resolved = resolveAdminToken(home, env);
    expect(resolved.token).toBe(env);
    expect(resolved.persisted).toBe(false);
    expect(existsSync(adminTokenPath(home))).toBe(false);
    expect(adminTokenLogLine(resolved)).toBeNull();
  });
});
