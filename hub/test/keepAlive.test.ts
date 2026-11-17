import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

function openSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

/** One HTTP/1.1 response. Bun json() sets content-length. */
function readResponse(socket: Socket): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const fail = (err: Error) => { cleanup(); reject(err); };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const head = buf.subarray(0, headerEnd).toString("latin1");
      const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0);
      const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? NaN);
      if (!Number.isFinite(len)) {
        cleanup();
        reject(new Error(`no content-length:\n${head}`));
        return;
      }
      if (buf.length < headerEnd + 4 + len) return;
      cleanup();
      resolve({ status });
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", onClose);
    };
    const onClose = () => fail(new Error("socket closed before response"));
    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", onClose);
  });
}

describe("HTTP keep-alive", () => {
  // WKWebView reuses the board socket. Bun's default idleTimeout (10s) closes it
  // first, and the next POST becomes TypeError: Load failed after the handler ran.
  test("a quiet socket still answers 12s later", async () => {
    hub = createServer({ port: 0, home: mkdtempSync(join(tmpdir(), "armada-keepalive-")) });
    const socket = await openSocket(hub.port);
    try {
      const req = `GET /api/machines HTTP/1.1\r\nHost: 127.0.0.1:${hub.port}\r\nAuthorization: Bearer ${hub.token}\r\nConnection: keep-alive\r\n\r\n`;
      const first = readResponse(socket);
      socket.write(req);
      expect((await first).status).toBe(200);
      await Bun.sleep(12_000);
      expect(socket.destroyed).toBe(false);
      const second = readResponse(socket);
      socket.write(req);
      expect((await second).status).toBe(200);
    } finally {
      socket.destroy();
    }
  }, 20_000);
});
