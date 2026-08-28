import type { Registry } from "./registry";

export interface WsData { connKey?: string; machineId?: string; windowId?: string; registered: boolean; regTimer?: ReturnType<typeof setTimeout>; }
export type ArmadaSocket = { data: WsData; send(s: string): void; close(code?: number, reason?: string): void };

export function handleWsMessage(reg: Registry, ws: ArmadaSocket, raw: string): void {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!ws.data.registered) {
    if (msg.type !== "register") { ws.close(4001, "unauthorized"); return; }
    reg.onRegister(ws, msg);
    return;
  }
  switch (msg.type) {
    case "heartbeat":
      reg.onHeartbeat(ws, msg);
      break;
    default:
      reg.dispatchInbound(ws, msg); // Task 4/5 在 Registry 上实现 run.ack/run.bound/run.event 等
  }
}
