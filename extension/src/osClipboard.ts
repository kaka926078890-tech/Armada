import { execFileSync, spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const WIN_HOST = [
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line -or $line -eq 'QUIT') { break }",
  "  $i = [System.Drawing.Image]::FromFile($line)",
  "  [System.Windows.Forms.Clipboard]::SetImage($i)",
  "  $i.Dispose()",
  "  [Console]::Out.WriteLine('OK')",
  "}",
].join("\n");

const WRITE_TIMEOUT_MS = 15_000;

export type ClipboardChild = {
  stdin: { write(s: string): unknown; end(): void };
  stdout: { on(ev: string, cb: (chunk: Buffer) => void): void };
  kill(): void;
};

export type OsClipboardDeps = {
  platform?: NodeJS.Platform;
  mkdtempSync: (prefix: string) => string;
  writeFileSync: (path: string, bytes: Buffer) => void;
  rmSync: (path: string, opts: { recursive: boolean; force: boolean }) => void;
  execFileSync: (cmd: string, args: string[], opts?: { timeout?: number }) => Buffer | string;
  spawn: (cmd: string, args: string[]) => ClipboardChild;
};

function defaultDeps(over: Partial<OsClipboardDeps> = {}): OsClipboardDeps {
  return {
    platform: (over.platform ?? process.platform) as NodeJS.Platform,
    mkdtempSync: over.mkdtempSync ?? ((p) => mkdtempSync(p)),
    writeFileSync: over.writeFileSync ?? writeFileSync,
    rmSync: over.rmSync ?? rmSync,
    execFileSync: over.execFileSync ?? execFileSync,
    spawn: over.spawn ?? ((cmd, args) => spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] }) as ClipboardChild),
  };
}

export type OsClipboardWriter = {
  write(bytes: Buffer, mime: string): Promise<void>;
  close(): Promise<void>;
};

export function createOsClipboardWriter(over: Partial<OsClipboardDeps> = {}): OsClipboardWriter {
  const deps = defaultDeps(over);
  let child: ClipboardChild | null = null;
  let acc = "";
  const waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  function takeOk(s: string): { hit: boolean; rest: string } {
    const ascii = s.indexOf("OK");
    if (ascii >= 0) return { hit: true, rest: s.slice(ascii + 2) };
    const u16 = s.indexOf("O\0K");
    if (u16 >= 0) return { hit: true, rest: s.slice(u16 + 3) };
    return { hit: false, rest: s };
  }

  function onStdout(chunk: Buffer) {
    acc += chunk.toString("utf8");
    while (waiters.length > 0) {
      const next = takeOk(acc);
      if (!next.hit) break;
      acc = next.rest;
      waiters.shift()!.resolve();
    }
  }

  function ensureWin() {
    if (child) return;
    child = deps.spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", WIN_HOST]);
    child.stdout.on("data", onStdout);
  }

  function waitOk(): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CLIPBOARD_TIMEOUT")), WRITE_TIMEOUT_MS);
      waiters.push({
        resolve: () => { clearTimeout(t); resolve(); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }

  async function write(bytes: Buffer, mime: string): Promise<void> {
    const dir = deps.mkdtempSync(join(tmpdir(), "armada-clip-"));
    const src = join(dir, mime === "image/png" ? "a.png" : "a.jpg");
    deps.writeFileSync(src, bytes);
    try {
      if (deps.platform === "darwin") {
        let png = src;
        if (mime !== "image/png") {
          png = join(dir, "a.png");
          deps.execFileSync("sips", ["-s", "format", "png", src, "--out", png], { timeout: WRITE_TIMEOUT_MS });
        }
        deps.execFileSync("osascript", ["-e", `set the clipboard to (read POSIX file ${JSON.stringify(png)} as «class PNGf»)`], { timeout: 10_000 });
        return;
      }
      if (deps.platform === "win32") {
        ensureWin();
        const pending = waitOk();
        child!.stdin.write(`${src}\n`);
        await pending;
        return;
      }
      throw new Error("CLIPBOARD_UNSUPPORTED_OS");
    } finally {
      try { deps.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async function close(): Promise<void> {
    if (!child) return;
    try { child.stdin.write("QUIT\n"); } catch { /* ignore */ }
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    child = null;
  }

  return { write, close };
}

export function writeOsImageClipboard(bytes: Buffer, mime: string): void {
  const dir = mkdtempSync(join(tmpdir(), "armada-clip-"));
  const src = join(dir, mime === "image/png" ? "a.png" : "a.jpg");
  writeFileSync(src, bytes);
  try {
    if (process.platform === "darwin") {
      let png = src;
      if (mime !== "image/png") {
        png = join(dir, "a.png");
        execFileSync("sips", ["-s", "format", "png", src, "--out", png], { timeout: WRITE_TIMEOUT_MS });
      }
      execFileSync("osascript", ["-e", `set the clipboard to (read POSIX file ${JSON.stringify(png)} as «class PNGf»)`], { timeout: 10_000 });
      return;
    }
    if (process.platform === "win32") {
      execFileSync("powershell.exe", [
        "-NoProfile", "-STA", "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile(${JSON.stringify(src)}); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()`,
      ], { timeout: WRITE_TIMEOUT_MS });
      return;
    }
    throw new Error("CLIPBOARD_UNSUPPORTED_OS");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
