import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

/** curl sees the server close like a browser does; Bun fetch does not. Exit 28 = still open at --max-time. */
async function streamOpenAfter(url: string, seconds: number): Promise<boolean> {
  const p = Bun.spawn(["curl", "-sN", "--max-time", String(seconds), url], { stdout: "ignore", stderr: "ignore" });
  return (await p.exited) === 28;
}

describe("SSE idle", () => {
  // Bun.serve closes a silent connection after 10 s (observed at ~12 s). A dropped stream loses run.status.
  test("run stream and board stream stay open past the idle limit", async () => {
    hub = createServer({ port: 0, home: mkdtempSync(join(tmpdir(), "armada-sse-")) });
    const base = `http://127.0.0.1:${hub.port}`;
    const [run, board] = await Promise.all([
      streamOpenAfter(`${base}/api/runs/r-idle/stream?token=${hub.token}`, 14),
      streamOpenAfter(`${base}/api/events?token=${hub.token}`, 14),
    ]);
    expect(run).toBe(true);
    expect(board).toBe(true);
  }, 30_000);
});
