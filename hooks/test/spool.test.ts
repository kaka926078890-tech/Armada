import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compileWindowsSpooler } from "../../extension/src/hooksInstall";

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

  test.skipIf(process.platform === "win32")("concurrent invocations do not interleave (maildir)", async () => {
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

  test("does not deadlock when Cursor keeps stdin open after compact JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-open-"));
    const body = JSON.stringify({ conversation_id: "c-open", workspace_roots: ["/ws/a"] });
    const proc = Bun.spawn(["sh", SCRIPT, "sessionStart"], {
      stdin: "pipe",
      stdout: "pipe",
      env: { ...process.env, ARMADA_SPOOL_DIR: dir },
    });
    proc.stdin.write(body);
    const killer = setTimeout(() => proc.kill(), 3000);
    const t0 = Date.now();
    const code = await proc.exited;
    clearTimeout(killer);
    const ms = Date.now() - t0;
    const out = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(ms).toBeLessThan(2500);
    expect(out.trim()).toBe("{}");
    expect(readSpoolJson(dir).__raw.conversation_id).toBe("c-open");
  });
});

describe("armada-spool.ps1", () => {
  const PS1 = join(import.meta.dir, "..", "armada-spool.ps1");

  test("writes utf-8 without bom via WriteAllText + Move-Item", () => {
    const src = readFileSync(PS1, "utf8");
    expect(src).toContain("UTF8Encoding");
    expect(src).toContain("WriteAllText");
    expect(src).toContain("Move-Item");
    expect(src).toContain("__unparsed");
  });

  const pwsh = Bun.which("pwsh") ?? (process.platform === "win32" ? "powershell.exe" : null);
  // Cursor wraps: $input | & { $input | & "script.ps1" event }. Do not use -File
  // (that hits Console.In / EOF deadlock and skips Unicode $input).
  const runPs = async (spoolDir: string, event: string, payload: object | string) => {
    const body = (typeof payload === "string" ? payload : JSON.stringify(payload)) + "\n";
    const cmd = "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false; $input | & '"
      + PS1.replace(/'/g, "''") + "' " + event;
    const proc = Bun.spawn([pwsh!, "-NoProfile", "-NonInteractive", "-Command", cmd], {
      stdin: new Response(body).body!,
      stdout: "pipe",
      env: { ...process.env, ARMADA_SPOOL_DIR: spoolDir },
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { out, code };
  };

  test.skipIf(!pwsh || process.platform === "win32")("runtime: valid json + invalid stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-ps1-"));
    const ok = await runPs(dir, "sessionStart", { conversation_id: "c-1" });
    expect(ok.code).toBe(0);
    expect(ok.out.trim()).toBe("{}");
    const j = readSpoolJson(dir);
    expect(j.__hook).toBe("sessionStart");
    expect(j.__raw.conversation_id).toBe("c-1");

    const dir2 = mkdtempSync(join(tmpdir(), "armada-spool-ps1-bad-"));
    const bad = await runPs(dir2, "stop", 'not json with "quotes"');
    expect(bad.code).toBe(0);
    expect(bad.out.trim()).toBe("{}");
    const j2 = readSpoolJson(dir2);
    expect(j2.__raw.__unparsed).toContain("not json");
  }, { timeout: 20000 });

  test.skipIf(!pwsh || process.platform === "win32")("preserves utf-8 prompt 你好 through PowerShell $input (not ???)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-ps1-hi-"));
    const ok = await runPs(dir, "beforeSubmitPrompt", {
      conversation_id: "c-hi",
      prompt: "你好",
      workspace_roots: ["/C:/Users/PC/Desktop/work"],
    });
    expect(ok.code).toBe(0);
    expect(ok.out.trim()).toBe("{}");
    const j = readSpoolJson(dir);
    expect(j.__raw.prompt).toBe("你好");
    expect(j.__raw.prompt).not.toBe("???");
  }, { timeout: 20000 });
});

describe("armada-spool.exe", () => {
  const CS = join(import.meta.dir, "..", "armada-spool.cs");

  test.skipIf(process.platform !== "win32")("exits on complete JSON while stdin stays open (utf-8)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-spool-exe-"));
    const exe = join(dir, "armada-spool.exe");
    const compiled = compileWindowsSpooler(CS, exe);
    expect(compiled.ok).toBe(true);

    const body = JSON.stringify({ conversation_id: "c-open", prompt: "你好", workspace_roots: ["/ws/a"] });
    const proc = Bun.spawn([exe, "beforeSubmitPrompt"], {
      stdin: "pipe",
      stdout: "pipe",
      env: { ...process.env, ARMADA_SPOOL_DIR: dir },
    });
    proc.stdin.write(body);
    const killer = setTimeout(() => proc.kill(), 3000);
    const t0 = Date.now();
    const code = await proc.exited;
    clearTimeout(killer);
    const ms = Date.now() - t0;
    const out = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(ms).toBeLessThan(1500);
    expect(out.trim()).toBe("{}");
    const j = readSpoolJson(dir);
    expect(j.__hook).toBe("beforeSubmitPrompt");
    expect(j.__raw.conversation_id).toBe("c-open");
    expect(j.__raw.prompt).toBe("你好");
  });
});
