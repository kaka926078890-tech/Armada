import { describe, expect, test } from "bun:test";
import { ReconnectPolicy, WsClientCore } from "../src/wsClient";

describe("ReconnectPolicy", () => {
  test("exponential backoff capped at 30s", () => {
    const p = new ReconnectPolicy();
    expect(p.nextDelay(0)).toBe(1000);
    expect(p.nextDelay(1)).toBe(2000);
    expect(p.nextDelay(2)).toBe(4000);
    expect(p.nextDelay(10)).toBe(30000);
  });
});

describe("WsClientCore outbound queue", () => {
  test("queues while disconnected, flushes on open in order", () => {
    const sent: any[] = [];
    const c = new WsClientCore((m) => sent.push(m));
    c.enqueue({ type: "a" });
    c.enqueue({ type: "b" });
    expect(sent).toHaveLength(0);
    c.onOpen();
    expect(sent.map((m) => m.type)).toEqual(["a", "b"]);
  });
  test("sends immediately when open", () => {
    const sent: any[] = [];
    const c = new WsClientCore((m) => sent.push(m));
    c.onOpen();
    c.enqueue({ type: "x" });
    expect(sent).toHaveLength(1);
  });
  test("onClose marks disconnected and returns delay", () => {
    const c = new WsClientCore(() => {});
    c.onOpen();
    const d = c.onClose();
    expect(d).toBe(1000);
    c.enqueue({ type: "y" });
    expect(c.pendingCount()).toBe(1);
  });
});
