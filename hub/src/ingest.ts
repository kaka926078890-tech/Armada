import type { Database } from "bun:sqlite";
import type { RunService } from "./runs";
import type { SseHub } from "./sse";

export function ingestEvent(db: Database, runs: RunService, sse: SseHub, machineId: string, msg: any): void {
  const extSeq = msg.seq;
  if (typeof extSeq !== "number") return;
  const ack = () => ({ type: "event.ack", machineId, lastSeq: extSeq });

  const cid = msg.conversationId || msg.payload?.conversation_id;
  const ACTIVE = ["created", "dispatched", "binding", "running"];
  let runId: string | undefined = msg.runId || undefined;
  let run = runId ? runs.get(runId) : null;
  // 扩展若把 stop 标到已终态的旧 run(同对话续聊/CDP 注入进原会话),改挂到该对话当前活跃 run
  if ((!run || !ACTIVE.includes(run.status)) && cid) {
    const live = runs.getActiveByConversation(cid);
    if (live) { runId = live.id; run = live; }
    else if (!run) { run = runs.getByConversation(cid); runId = run?.id; }
  }
  if (!runId) { (msg as any).__ack = ack(); return; }
  if (!run) { (msg as any).__ack = ack(); return; }

  const dup = db.query("SELECT id FROM run_events WHERE machine_id=?1 AND ext_seq=?2").get(machineId, extSeq);
  if (dup) { (msg as any).__ack = ack(); return; }

  const maxSeq = (db.query("SELECT COALESCE(MAX(seq),0) AS m FROM run_events WHERE run_id=?1").get(runId) as any).m as number;
  const terminal = !["created", "dispatched", "binding", "running"].includes(run.status);
  db.query(`INSERT INTO run_events (run_id, seq, machine_id, ext_seq, source, hook_event_name, payload, ts, post_terminal)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
    .run(runId, maxSeq + 1, machineId, extSeq, msg.source ?? "hook", msg.hookEventName ?? null,
         JSON.stringify(msg.payload ?? {}), msg.ts ?? Date.now(), terminal ? 1 : 0);

  if (msg.hookEventName === "stop") runs.onStopEvent(runId, msg.payload);
  sse.broadcast(runId, { type: "run.event", runId, seq: maxSeq + 1, hookEventName: msg.hookEventName, payload: msg.payload, ts: msg.ts });
  (msg as any).__ack = ack();
}
