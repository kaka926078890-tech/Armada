import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireCdpLock } from "../src/cdpLock";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("acquireCdpLock", () => {
  test("second acquire times out while first is held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdp-lock-"));
    const lockPath = join(dir, "cdp.lock");
    const first = await acquireCdpLock({ lockPath, timeoutMs: 200, sleep });
    expect(first.ok).toBe(true);
    const second = await acquireCdpLock({ lockPath, timeoutMs: 120, sleep });
    expect(second.ok).toBe(false);
    if (first.ok) first.release();
    const third = await acquireCdpLock({ lockPath, timeoutMs: 200, sleep });
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });

  test("dead pid steal succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdp-lock-"));
    const lockPath = join(dir, "cdp.lock");
    writeFileSync(lockPath, "99999999\n");
    const got = await acquireCdpLock({ lockPath, timeoutMs: 200, sleep });
    expect(got.ok).toBe(true);
    if (got.ok) got.release();
  });
});
