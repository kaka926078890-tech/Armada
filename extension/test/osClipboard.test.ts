import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { createOsClipboardWriter, type OsClipboardDeps } from "../src/osClipboard";

function winDeps(spawns: { cmd: string; writes: string[] }[]): OsClipboardDeps {
  return {
    platform: "win32",
    mkdtempSync: () => "/tmp/armada-clip-test",
    writeFileSync: () => {},
    rmSync: () => {},
    execFileSync: () => Buffer.from(""),
    spawn: (cmd, _args) => {
      const rec = { cmd, writes: [] as string[] };
      spawns.push(rec);
      const listeners = new Map<string, (chunk: Buffer) => void>();
      return {
        stdin: {
          write(s: string) {
            rec.writes.push(s);
            queueMicrotask(() => listeners.get("data")?.(Buffer.from("OK\n")));
            return true;
          },
          end() {},
        },
        stdout: {
          on(ev: string, cb: (chunk: Buffer) => void) {
            if (ev === "data") listeners.set("data", cb);
          },
        },
        kill() {},
      };
    },
  };
}

describe("createOsClipboardWriter", () => {
  test("windows batch writes spawn powershell once", async () => {
    const spawns: { cmd: string; writes: string[] }[] = [];
    const writer = createOsClipboardWriter(winDeps(spawns));
    await writer.write(Buffer.from("a"), "image/png");
    await writer.write(Buffer.from("b"), "image/png");
    await writer.close();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.cmd).toBe("powershell.exe");
    expect(spawns[0]!.writes.filter((s) => s !== "QUIT\n")).toHaveLength(2);
  });

  test("writeOsImageClipboard is not a second clipboard writer", () => {
    const src = readFileSync(join(import.meta.dir, "../src/osClipboard.ts"), "utf8");
    expect(src).not.toMatch(/export function writeOsImageClipboard/);
    expect([...src.matchAll(/Clipboard\]::SetImage/g)]).toHaveLength(1);
  });
});
