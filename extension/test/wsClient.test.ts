import { describe, expect, test } from "bun:test";
import { WsClientCore } from "../src/wsClient";

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
