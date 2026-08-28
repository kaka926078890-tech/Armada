import type { Database } from "bun:sqlite";
import type { RunService } from "./runs";
import type { SseHub } from "./sse";

export function ingestEvent(db: Database, runs: RunService, sse: SseHub, machineId: string, msg: any): void {
  const extSeq = msg.seq;
  if (typeof extSeq !== "number") return;
  const ack = () => ({ type: "event.ack", machineId, lastSeq: extSeq });

  const runId = msg.runId || runs.getByConversation(msg.conversationId)?.id;

  // 去重:(machine_id, ext_seq) 已存在 → 仅 ack
  const dup = db.query("SELECT id FROM run_events WHERE machine_id=?1 AND ext_seq=?2").get(machineId, extSeq);
  if (dup) { (msg as any).__ack = ack(); return; }

  if (!runId) { (msg as any).__ack = ack(); return; } // 无法归属:ack 掉避免无限重发
  const run = runs.get(runId);
  if (!run) { (msg as any).__ack = ack(); return; }

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
