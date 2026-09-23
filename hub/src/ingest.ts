import type { Database } from "bun:sqlite";
import type { RunService } from "./runs";
import type { SseHub } from "./sse";
import { hookSubmitPrompt, transcriptUserPrompt } from "./outboundClaim";
import { stopFromCursorSessionEnd, stopFromJsonlTurnEnded, genOf } from "./generationOwnership";
import { ACTIVE_STATUSES, OCCUPYING_STATUSES, TERMINAL_STATUSES } from "./concurrency";

/** runId → 该任务派出的子代理 conversation_id。缓存；重启后从 run_events 重建。 */
const subagentCids = new Map<string, Set<string>>();

export function clearSubagentCidCache(): void {
  subagentCids.clear();
}

function transcriptPathForCid(path: unknown, cid: string): string | null {
  if (typeof path !== "string" || !cid) return null;
  const norm = path.replace(/\\/g, "/");
  const marker = `/agent-transcripts/${cid}/`;
  if (!norm.includes(marker)) return null;
  if (norm.endsWith(`/${cid}.jsonl`) || norm.includes(`${marker}subagents/`)) return path;
  return null;
}

export function cidBelongsToRun(
  run: { id?: string; conversation_id?: string | null },
  cid: unknown,
  payload: any,
  childCids?: Set<string>,
): boolean {
  const owner = run.conversation_id;
  if (!owner) return true;
  if (typeof cid !== "string" || !cid) return true;
  if (cid === owner) return true;
  if (payload?.parent_conversation_id === owner) return true;
  if (run.id && (childCids ?? subagentCids.get(run.id))?.has(cid)) return true;
  return false;
}

function childCidsFromEvents(db: Database, runId: string): Set<string> {
  const rows = db.query(
    `SELECT payload FROM run_events WHERE run_id=?1 AND hook_event_name='subagentStart'`,
  ).all(runId) as { payload: string }[];
  const set = new Set<string>();
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload) as { conversation_id?: unknown };
      if (typeof p.conversation_id === "string" && p.conversation_id) set.add(p.conversation_id);
    } catch { /* skip */ }
  }
  return set;
}

function rememberedChildCids(db: Database, runId: string): Set<string> {
  let set = subagentCids.get(runId);
  if (!set) {
    set = childCidsFromEvents(db, runId);
    subagentCids.set(runId, set);
  }
  return set;
}

const TRANSCRIPT_SOURCES = new Set(["transcript", "subagent-transcript"]);
/** Identical `turn_ended` from a second tailer lands in the same second; a later turn is minutes later. */
const REPEAT_TURN_ENDED_MS = 60_000;

function jsonlTurnEndedMayStop(db: Database, runId: string): boolean {
  const hubBsp = db.query(
    `SELECT seq FROM run_events WHERE run_id=?1 AND source='hub' AND hook_event_name='beforeSubmitPrompt'
     ORDER BY seq DESC LIMIT 1`,
  ).get(runId) as { seq: number } | undefined;
  if (!hubBsp) return true;
  const user = db.query(
    `SELECT 1 AS n FROM run_events WHERE run_id=?1 AND source='transcript'
     AND json_extract(payload, '$.role')='user' AND seq > ?2 LIMIT 1`,
  ).get(runId, hubBsp.seq) as { n: number } | null;
  return !!user;
}

/** Second Cursor window tails the same cid jsonl with a different ext_seq clock (r-182f5c19). */
export function isRepeatTranscriptPayload(
  source: unknown,
  payload: unknown,
  stored: { ts: number } | null | undefined,
  eventTs: number,
): boolean {
  if (typeof source !== "string" || !TRANSCRIPT_SOURCES.has(source) || !stored) return false;
  const role = payload && typeof payload === "object" ? (payload as { role?: unknown }).role : undefined;
  if (role === "user" || role === "assistant") return true;
  return Math.abs(eventTs - stored.ts) < REPEAT_TURN_ENDED_MS;
}

function cdpAskOwnsConversation(
  run: { id?: string; conversation_id?: string | null },
  msg: any,
  cid: unknown,
  childCids?: Set<string>,
): boolean {
  if (msg.source !== "cdp") return true;
  if (msg.hookEventName !== "askQuestion" && msg.hookEventName !== "askQuestionResolved") return true;
  // Windows 旧扩展只带 runId、不带 cid；run 已由 runId 钉死。空 cid 不得再丢。
  // 外卡仍靠下面 cidBelongsToRun（cid 有值且不等于主人 → 丢）。
  if (typeof cid !== "string" || !cid) return true;
  return cidBelongsToRun(run, cid, msg.payload, childCids);
}

export function ingestEvent(db: Database, runs: RunService, sse: SseHub, machineId: string, msg: any): void {
  const extSeq = msg.seq;
  if (typeof extSeq !== "number") return;
  const ack = () => ({ type: "event.ack", machineId, lastSeq: extSeq });

  const cid = msg.conversationId || msg.payload?.conversation_id;
  const roots: string[] = Array.isArray(msg.payload?.workspace_roots) ? msg.payload.workspace_roots : [];
  const active = ACTIVE_STATUSES as readonly string[];
  let runId: string | undefined = msg.runId || undefined;
  let run = runId ? runs.get(runId) : null;
  // 扩展若把 stop 标到已终态的旧 run(同对话续聊/CDP 注入进原会话),改挂到该对话当前活跃 run
  if ((!run || !active.includes(run.status)) && cid) {
    const live = runs.getActiveByConversation(cid);
    if (live) { runId = live.id; run = live; }
  }
  // 共享 spool 被其它窗口先转发时 runId 为空:prompt 对齐的 beforeSubmitPrompt 才能挂到等待绑定的任务
  const submitHook = msg.hookEventName === "beforeSubmitPrompt";
  if ((!run || !active.includes(run.status)) && roots.length && submitHook) {
    const waiting = runs.findAttachableRun(machineId, roots, msg.payload?.prompt);
    if (waiting) { runId = waiting.id; run = waiting; }
  }
  if (!runId) { (msg as any).__ack = ack(); return; }
  if (!run) { (msg as any).__ack = ack(); return; }
  const childCids = rememberedChildCids(db, runId);
  if (!cidBelongsToRun(run, cid, msg.payload, childCids)) { (msg as any).__ack = ack(); return; }
  if (!cdpAskOwnsConversation(run, msg, cid, childCids)) { (msg as any).__ack = ack(); return; }
  if (submitHook && !run.conversation_id) {
    const p = typeof msg.payload?.prompt === "string" ? msg.payload.prompt : "";
    if (!runs.submitPromptMatches(run, p)) { (msg as any).__ack = ack(); return; }
  }

  const dup = db.query("SELECT id FROM run_events WHERE machine_id=?1 AND ext_seq=?2").get(machineId, extSeq);
  if (dup) { (msg as any).__ack = ack(); return; }

  const source = msg.source ?? "hook";
  if (TRANSCRIPT_SOURCES.has(source)) {
    const body = JSON.stringify(msg.payload ?? {});
    const prev = db.query(
      `SELECT ts FROM run_events WHERE run_id=?1 AND source=?2 AND payload=?3 ORDER BY seq DESC LIMIT 1`,
    ).get(runId, source, body) as { ts: number } | undefined;
    if (isRepeatTranscriptPayload(source, msg.payload, prev, msg.ts ?? Date.now())) {
      (msg as any).__ack = ack();
      return;
    }
  }

  if (source === "transcript" && runs.reopenAfterResumeStall(runId, msg.payload)) {
    run = runs.get(runId) ?? run;
  }

  const maxSeq = (db.query("SELECT COALESCE(MAX(seq),0) AS m FROM run_events WHERE run_id=?1").get(runId) as any).m as number;
  const terminal = !(ACTIVE_STATUSES as readonly string[]).includes(run.status);
  db.query(`INSERT INTO run_events (run_id, seq, machine_id, ext_seq, source, hook_event_name, payload, ts, post_terminal)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
    .run(runId, maxSeq + 1, machineId, extSeq, source, msg.hookEventName ?? null,
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
  run = runs.get(runId) ?? run;
  if (msg.hookEventName === "beforeSubmitPrompt") {
    runs.tryArmLiveGeneration(runId, msg.hookEventName, msg.payload, cid);
    const bsp = hookSubmitPrompt(msg.payload);
    if (bsp) runs.claimOutbound(runId, bsp, msg.ts ?? Date.now());
  }
  if (msg.hookEventName === "preToolUse") {
    runs.tryArmLiveGeneration(runId, msg.hookEventName, msg.payload, cid);
  }
  if (msg.source === "transcript") {
    const user = transcriptUserPrompt(msg.payload);
    if (user) runs.claimOutbound(runId, user, msg.ts ?? Date.now());
    const mapped = stopFromJsonlTurnEnded(msg.payload);
    if (mapped && jsonlTurnEndedMayStop(db, runId)) {
      run = runs.get(runId) ?? run;
      const live = genOf(run.live_generation_id);
      const payloadGen = genOf((msg.payload as { generation_id?: unknown } | undefined)?.generation_id);
      runs.onStopEvent(runId, {
        ...mapped,
        conversation_id: cid ?? run.conversation_id,
        ...(payloadGen || live ? { generation_id: payloadGen ?? live } : {}),
      });
      if (run.conversation_id && cid === run.conversation_id) subagentCids.delete(runId);
    }
  }
  if (msg.hookEventName === "subagentStart" && typeof cid === "string" && run.conversation_id && cid !== run.conversation_id) {
    rememberedChildCids(db, runId).add(cid);
  }
  if (msg.hookEventName === "askQuestion") {
    runs.applyAskQuestion(runId, msg.payload);
  }
  if (msg.hookEventName === "askQuestionResolved") {
    runs.resolveAskQuestion(runId, msg.payload?.request_id);
  }
  if (msg.hookEventName === "stop") {
    runs.onStopEvent(runId, msg.payload);
    if (run.conversation_id && cid === run.conversation_id) subagentCids.delete(runId);
  }
  if (msg.hookEventName === "sessionEnd") {
    const mapped = stopFromCursorSessionEnd(msg.payload);
    if (mapped) {
      runs.onStopEvent(runId, mapped);
      if (run.conversation_id && cid === run.conversation_id) subagentCids.delete(runId);
    }
  }
  sse.broadcast(runId, { type: "run.event", runId, seq: maxSeq + 1, hookEventName: msg.hookEventName, payload: msg.payload, ts: msg.ts });
  (msg as any).__ack = ack();
}
