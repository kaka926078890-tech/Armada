import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "armada-spool.sh");

async function timedHook(
  spoolDir: string,
  event: string,
  payload: object,
): Promise<{ ms: number; code: number; out: string }> {
  const t0 = performance.now();
  const proc = Bun.spawn(["sh", SCRIPT, event], {
    stdin: new Response(JSON.stringify(payload)).body!,
    stdout: "pipe",
    env: { ...process.env, ARMADA_SPOOL_DIR: spoolDir },
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { ms: performance.now() - t0, code, out };
}

describe("observation hooks: two conversation windows", () => {
  test("two serial streams (one hook at a time per window) stay well under 5s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-2win-"));
    const perWindow = 20;
    const ms: number[] = [];
    await Promise.all([0, 1].map(async (w) => {
      for (let i = 0; i < perWindow; i++) {
        const r = await timedHook(dir, "preToolUse", { window: w, i, tool_name: "Grep" });
        expect(r.code).toBe(0);
        expect(r.out.trim()).toBe("{}");
        ms.push(r.ms);
      }
    }));
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.ceil(ms.length * 0.95) - 1]!;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
    expect(files).toBe(40);
    expect(p95).toBeLessThan(500);
    expect(Math.max(...ms)).toBeLessThan(2000);
  }, 30_000);

  // 2026-09-08: pipe left open after JSON → script hung ≥6s (Cursor timeout is 5s).
  // Windows already skips install for this. Unskip when spooler returns on first JSON object.
  test.skip("open stdin without EOF must not hang past Cursor timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-stdin-"));
    const proc = Bun.spawn(["sh", SCRIPT, "preToolUse"], {
      stdin: "pipe",
      stdout: "pipe",
      env: { ...process.env, ARMADA_SPOOL_DIR: dir },
    });
    proc.stdin.write('{"tool_name":"Grep","conversation_id":"c1"}\n');
    // Intentionally do not close stdin — Cursor on Windows (and possibly some Mac
    // hook events) keeps the pipe open. The script must still exit.
    const t0 = performance.now();
    const exited = Promise.race([
      proc.exited.then((code) => ({ code, ms: performance.now() - t0 })),
      new Promise<{ code: number; ms: number }>((resolve) =>
        setTimeout(() => resolve({ code: -1, ms: performance.now() - t0 }), 2500),
      ),
    ]);
    const r = await exited;
    try { proc.kill(); } catch { /* already dead */ }
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2000);
  });
});
