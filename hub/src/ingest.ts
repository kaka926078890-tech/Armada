import type { Database } from "bun:sqlite";
import type { RunService } from "./runs";
import type { SseHub } from "./sse";

/** runId → 该任务派出的子代理 conversation_id */
const subagentCids = new Map<string, Set<string>>();

function transcriptPathForCid(path: unknown, cid: string): string | null {
  if (typeof path !== "string" || !cid) return null;
  const norm = path.replace(/\\/g, "/");
  const marker = `/agent-transcripts/${cid}/`;
  if (!norm.includes(marker)) return null;
  if (norm.endsWith(`/${cid}.jsonl`) || norm.includes(`${marker}subagents/`)) return path;
  return null;
}

export function cidBelongsToRun(run: { id?: string; conversation_id?: string | null }, cid: unknown, payload: any): boolean {
  const owner = run.conversation_id;
  if (!owner) return true;
  if (typeof cid !== "string" || !cid) return true;
  if (cid === owner) return true;
  if (payload?.parent_conversation_id === owner) return true;
  if (run.id && subagentCids.get(run.id)?.has(cid)) return true;
  return false;
}

export function ingestEvent(db: Database, runs: RunService, sse: SseHub, machineId: string, msg: any): void {
  const extSeq = msg.seq;
  if (typeof extSeq !== "number") return;
  const ack = () => ({ type: "event.ack", machineId, lastSeq: extSeq });

  const cid = msg.conversationId || msg.payload?.conversation_id;
  const roots: string[] = Array.isArray(msg.payload?.workspace_roots) ? msg.payload.workspace_roots : [];
  const ACTIVE = ["created", "dispatched", "binding", "running"];
  let runId: string | undefined = msg.runId || undefined;
  let run = runId ? runs.get(runId) : null;
  // 扩展若把 stop 标到已终态的旧 run(同对话续聊/CDP 注入进原会话),改挂到该对话当前活跃 run
  if ((!run || !ACTIVE.includes(run.status)) && cid) {
    const live = runs.getActiveByConversation(cid);
    if (live) { runId = live.id; run = live; }
  }
  // 共享 spool 被其它窗口先转发时 runId 为空:prompt 对齐的 beforeSubmitPrompt 才能挂到等待绑定的任务
  const submitHook = msg.hookEventName === "beforeSubmitPrompt";
  if ((!run || !ACTIVE.includes(run.status)) && roots.length && submitHook) {
    const waiting = runs.findAttachableRun(machineId, roots, msg.payload?.prompt);
    if (waiting) { runId = waiting.id; run = waiting; }
  }
  if (!runId) { (msg as any).__ack = ack(); return; }
  if (!run) { (msg as any).__ack = ack(); return; }
  if (!cidBelongsToRun(run, cid, msg.payload)) { (msg as any).__ack = ack(); return; }
  if (submitHook && !run.conversation_id) {
    const p = typeof msg.payload?.prompt === "string" ? msg.payload.prompt.trim() : "";
    if (p !== String(run.prompt ?? "").trim()) { (msg as any).__ack = ack(); return; }
  }

  const dup = db.query("SELECT id FROM run_events WHERE machine_id=?1 AND ext_seq=?2").get(machineId, extSeq);
  if (dup) { (msg as any).__ack = ack(); return; }

  const maxSeq = (db.query("SELECT COALESCE(MAX(seq),0) AS m FROM run_events WHERE run_id=?1").get(runId) as any).m as number;
  const terminal = !["created", "dispatched", "binding", "running"].includes(run.status);
  db.query(`INSERT INTO run_events (run_id, seq, machine_id, ext_seq, source, hook_event_name, payload, ts, post_terminal)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
    .run(runId, maxSeq + 1, machineId, extSeq, msg.source ?? "hook", msg.hookEventName ?? null,
         JSON.stringify(msg.payload ?? {}), msg.ts ?? Date.now(), terminal ? 1 : 0);

  // sessionStart 在 newAgentChat 瞬间触发,不得据此进入 running
  if (cid && submitHook) {
    if (["dispatched", "binding"].includes(run.status) || run.end_reason === "BIND_TIMEOUT" || run.end_reason === "DISPATCH_TIMEOUT") {
      runs.onRunBound(machineId, {
        runId,
        conversationId: cid,
        transcriptPath: transcriptPathForCid(msg.payload?.transcript_path ?? msg.transcriptPath, cid),
        promptMatch: false,
      });
      run = runs.get(runId) ?? run;
    }
  }
  if (msg.hookEventName === "subagentStart" && typeof cid === "string" && run.conversation_id && cid !== run.conversation_id) {
    const set = subagentCids.get(runId) ?? new Set<string>();
    set.add(cid);
    subagentCids.set(runId, set);
  }
  if (msg.hookEventName === "stop") {
    runs.onStopEvent(runId, msg.payload);
    if (run.conversation_id && cid === run.conversation_id) subagentCids.delete(runId);
  }
  sse.broadcast(runId, { type: "run.event", runId, seq: maxSeq + 1, hookEventName: msg.hookEventName, payload: msg.payload, ts: msg.ts });
  (msg as any).__ack = ack();
}
