import { describe, expect, test } from "bun:test";
import { byteFrames } from "../../relay/src/desktopFrames";
import { hubLoopbackHeaders } from "../src/relayClient";
import { createDeskTunnel } from "../src/deskTunnel";

describe("hub loopback headers", () => {
  test("keeps the json default and lets blob put replace it", () => {
    const plain = hubLoopbackHeaders("hub-token", undefined) as Record<string, string>;
    expect(plain["content-type"]).toBe("application/json");
    expect(plain.authorization).toBe("Bearer hub-token");
    const blob = hubLoopbackHeaders("hub-token", {
      "content-type": "multipart/form-data; boundary=abc",
      authorization: "Bearer caller",
    }) as Record<string, string>;
    expect(blob["content-type"]).toBe("multipart/form-data; boundary=abc");
    expect(blob.authorization).toBe("Bearer hub-token");
  });
});

describe("desk tunnel", () => {
  test("reassembles a multipart post and does not enter command handling", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const sent: any[] = [];
    const onDesk = createDeskTunnel({
      localWsUrl: "ws://127.0.0.1:1/ws?token=x",
      send: (msg) => sent.push(msg),
      hubFetch: async (path, init) => {
        calls.push({ path, init });
        return new Response("ok-body", { status: 201, headers: { "content-type": "text/plain" } });
      },
    });
    const raw = new Uint8Array(70 * 1024);
    raw[0] = 3;
    const frames = byteFrames(raw);
    await onDesk({ type: "desk.nope" });
    for (const frame of frames) {
      await onDesk({
        type: "desk.http", streamId: "s", method: "POST", path: "/api/blobs",
        headers: { "content-type": "multipart/form-data; boundary=b" },
        ...frame,
      });
    }
    expect(calls[0]?.path).toBe("/api/blobs");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("multipart/form-data; boundary=b");
    expect(Buffer.from(calls[0]?.init?.body as Uint8Array).length).toBe(70 * 1024);
    expect(sent[0]?.type).toBe("desk.http.result");
    expect(sent[0]?.status).toBe(201);
    expect(sent.at(-1)?.last).toBe(true);
  });

  test("flushes sse chunks before the stream ends", async () => {
    const sent: any[] = [];
    let push: (b: Uint8Array) => void = () => {};
    let close: () => void = () => {};
    const body = new ReadableStream({
      start(controller) {
        push = (b) => controller.enqueue(b);
        close = () => controller.close();
      },
    });
    const onDesk = createDeskTunnel({
      localWsUrl: "ws://127.0.0.1:1/ws?token=x",
      send: (msg) => sent.push(msg),
      hubFetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    const pending = onDesk({ type: "desk.stream.open", streamId: "e", path: "/api/events" });
    await new Promise((r) => setTimeout(r, 0));
    push(new TextEncoder().encode(":ok\n\n"));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.some((m) => m.type === "desk.stream.chunk" && m.data === ":ok\n\n" && m.last == null)).toBe(true);
    close();
    await pending;
    expect(sent.at(-1)?.type).toBe("desk.stream.end");
  });

  test("writes one local text frame after reassembly and returns close codes", async () => {
    const sent: any[] = [];
    const localMessages: string[] = [];
    let closed: { code?: number } = {};
    const onDesk = createDeskTunnel({
      localWsUrl: "ws://127.0.0.1:9/ws?token=secret",
      send: (msg) => sent.push(msg),
      openLocalWs: () => ({
        send: (data) => localMessages.push(data),
        close: (code) => { closed = { code }; },
        onmessage: null,
        onclose: null,
      }),
    });
    await onDesk({ type: "desk.ws.open", streamId: "w" });
    await onDesk({ type: "desk.ws.frame", streamId: "w", seq: 0, last: false, data: "hello " });
    expect(localMessages).toEqual([]);
    await onDesk({ type: "desk.ws.frame", streamId: "w", seq: 1, last: true, data: "world" });
    expect(localMessages).toEqual(["hello world"]);
    await onDesk({ type: "desk.ws.close", streamId: "w", code: 4001, reason: "register" });
    expect(closed.code).toBe(4001);
    expect(sent.every((m) => m.type !== "cmd.result")).toBe(true);
  });
});
