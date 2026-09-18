import { describe, expect, test } from "bun:test";
import { WS_STALE_MS, WsClientCore } from "../src/wsClient";

describe("WsClientCore register-before-flush", () => {
  test("queued ack is not sent until onRegistered (avoids hub 4001)", () => {
    const sent: object[] = [];
    const core = new WsClientCore((m) => sent.push(m));
    core.enqueue({ type: "hooks.status" });
    core.enqueue({ type: "run.ack", runId: "r-1" });
    core.onOpen();
    core.sendRegister({ type: "register" });
    expect(sent).toEqual([{ type: "register" }]);
    expect(core.pendingCount()).toBe(2);
    core.onRegistered();
    expect(sent.map((m: any) => m.type)).toEqual(["register", "hooks.status", "run.ack"]);
  });

  test("close then open: unsent ack survives 4001 cycle", () => {
    const sent: object[] = [];
    const core = new WsClientCore((m) => sent.push(m));
    core.enqueue({ type: "run.ack" });
    core.onOpen();
    core.sendRegister({ type: "register" });
    // 模拟 hub 因先收到 ack 而 4001:此时尚未 onRegistered
    core.onClose();
    sent.length = 0;
    core.onOpen();
    core.sendRegister({ type: "register" });
    core.onRegistered();
    expect(sent.map((m: any) => m.type)).toEqual(["register", "run.ack"]);
  });

  test("ready 时发出的 ack 在 1006 后仍会补发(当前窗 newAgentChat 死链路)", () => {
    const sent: object[] = [];
    const core = new WsClientCore((m) => sent.push(m));
    core.onOpen();
    core.sendRegister({ type: "register" });
    core.onRegistered();
    core.enqueue({ type: "run.ack", runId: "r-1", status: "accepted" });
    expect(sent.filter((m: any) => m.type === "run.ack")).toHaveLength(1);
    core.onClose();
    sent.length = 0;
    core.onOpen();
    core.sendRegister({ type: "register" });
    expect(sent.map((m: any) => m.type)).toEqual(["register"]);
    core.onRegistered();
    expect(sent.map((m: any) => m.type)).toEqual(["register", "run.ack"]);
    expect((sent[1] as any).runId).toBe("r-1");
  });

  test("ready 时发出的 synthesized stop 在 1006 后仍会补发", () => {
    const sent: object[] = [];
    const core = new WsClientCore((m) => sent.push(m));
    core.onOpen();
    core.sendRegister({ type: "register" });
    core.onRegistered();
    core.enqueue({
      type: "run.event", runId: "r-1", source: "hook", hookEventName: "stop",
      payload: { status: "completed" }, seq: 9,
    });
    expect(sent.filter((m: any) => m.hookEventName === "stop")).toHaveLength(1);
    core.onClose();
    sent.length = 0;
    core.onOpen();
    core.sendRegister({ type: "register" });
    core.onRegistered();
    expect(sent.filter((m: any) => m.hookEventName === "stop")).toHaveLength(1);
  });

  test("ready 但 socket 已死:ack 入队,不丢", () => {
    const sent: object[] = [];
    let open = true;
    const core = new WsClientCore((m) => sent.push(m), () => open);
    core.onOpen();
    core.sendRegister({ type: "register" });
    core.onRegistered();
    open = false;
    core.enqueue({ type: "run.ack", runId: "r-dead", status: "accepted" });
    expect(sent.filter((m: any) => m.type === "run.ack")).toHaveLength(0);
    expect(core.pendingCount()).toBe(1);
    core.onClose();
    open = true;
    sent.length = 0;
    core.onOpen();
    core.sendRegister({ type: "register" });
    core.onRegistered();
    expect(sent.map((m: any) => m.type)).toEqual(["register", "run.ack"]);
  });
});

describe("WsClientCore stale-socket reconnect", () => {
  test("does not reconnect before registered even if inbound is old", () => {
    const core = new WsClientCore(() => {});
    core.onOpen();
    expect(core.shouldReconnect(1_000_000)).toBe(false);
  });

  test("reconnects when ready and hub has been silent past stale window", () => {
    const core = new WsClientCore(() => {});
    core.onOpen();
    core.sendRegister({ type: "register" });
    core.onRegistered();
    core.noteInbound(10_000);
    expect(core.shouldReconnect(10_000 + WS_STALE_MS - 1)).toBe(false);
    expect(core.shouldReconnect(10_000 + WS_STALE_MS)).toBe(true);
  });

  test("close then register resets stale clock (does not immediately reconnect)", () => {
    const core = new WsClientCore(() => {});
    core.onOpen();
    core.onRegistered();
    core.noteInbound(1);
    expect(core.shouldReconnect(1 + WS_STALE_MS)).toBe(true);
    core.onClose();
    core.onOpen();
    core.onRegistered();
    expect(core.shouldReconnect(1 + WS_STALE_MS)).toBe(false);
  });
});
