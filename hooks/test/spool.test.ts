import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "armada-spool.sh");

async function runHook(spoolDir: string, event: string, payload: object | string) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const proc = Bun.spawn(["sh", SCRIPT, event], {
    stdin: new Response(body).body!,
    stdout: "pipe",
    env: { ...process.env, ARMADA_SPOOL_DIR: spoolDir },
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

function readSpoolJson(dir: string) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
}

describe("armada-spool.sh", () => {
  test("writes one json file per invocation with wrapper fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-"));
    const { out, code } = await runHook(dir, "sessionStart", {
      conversation_id: "c-1",
      workspace_roots: ["/ws/a"],
    });
    expect(code).toBe(0);
    expect(out.trim()).toBe("{}");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const j = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    expect(j.__hook).toBe("sessionStart");
    expect(typeof j.__ts).toBe("number");
    expect(j.__raw.conversation_id).toBe("c-1");
  });

  test("concurrent invocations do not interleave (maildir)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-"));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        runHook(dir, "preToolUse", { i, big: "x".repeat(2000) }),
      ),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(20);
    for (const f of files) {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      expect(j.__hook).toBe("preToolUse");
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  test("invalid stdin still exits 0 with {}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-"));
    const proc = Bun.spawn(["sh", SCRIPT, "stop"], {
      stdin: new Response("not json").body!,
      stdout: "pipe",
      env: { ...process.env, ARMADA_SPOOL_DIR: dir },
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe("{}");
  });

  test("invalid stdin wraps __unparsed with escaped content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-"));
    const raw = 'not json with "quotes"\nand\tnewline';
    const { code, out } = await runHook(dir, "stop", raw);
    expect(code).toBe(0);
    expect(out.trim()).toBe("{}");
    const j = readSpoolJson(dir);
    expect(j.__hook).toBe("stop");
    expect(typeof j.__ts).toBe("number");
    expect(j.__raw.__unparsed).toBe(raw);
  });

  test("invalid stdin truncates __unparsed to 4000 chars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-"));
    const raw = "z".repeat(5000);
    await runHook(dir, "stop", raw);
    const j = readSpoolJson(dir);
    expect(j.__raw.__unparsed).toHaveLength(4000);
  });
});
