import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { InjectRoute, Registry } from "./registry";
import type { SseHub } from "./sse";
import {
  type ConcurrencyLimits,
  limitsFromEnv,
  normalizePrompt,
  extensionSupportsMultiRunPerWindow,
  OCCUPYING_STATUSES,
  ACTIVE_STATUSES,
  ENDED_STATUSES,
  INJECTING_STATUSES,
  PROGRESSING_STATUSES,
  sqlStatusIn,
  isStatus,
  canRetryStatus,
} from "./concurrency";
import { workspacePathIn } from "../../extension/src/workspacePath";
import { BIND_TIMEOUT_MS, WINDOWS_BIND_TIMEOUT_MS } from "../../extension/src/transcriptBind";
import { collisionKey, hasImageMarkers, stripImageMarkers } from "../../extension/src/imageMarkers";
import { BlobStore, parseAttachmentIds, type BlobMeta } from "./blobs";
import { appendRetired, decideArm, decideStop, parseRetiredIds, isWindowsMachineOs, genOf, stopFromCursorSessionEnd } from "./generationOwnership";
import { parsePendingAsk, continueAllowed, optionInAsk, isPlanAsk, mergePendingAskRecord, ASK_TEXT_MAX } from "./pendingAsk";
import {
  OUTBOUND_LIMIT, QUEUE_DRAIN_MS, queueModeOf,
} from "./outboundClaim";

const DISPATCH_TIMEOUT_MS = 30_000;

function publicRunError(reason: string): string {
  if (reason === "CDP_UNREACHABLE" || reason.startsWith("CDP_CONNECT_FAIL")) return "CDP_NOT_READY";
  return reason;
}

export class RunService {
  private cancelRequested = new Set<string>();
  private promoting = false;
  private limits: ConcurrencyLimits;
  private sessionEndReplaySeq = new Map<string, number>();

  constructor(
    private db: Database,
    private registry: Registry,
    private sse: SseHub,
    opts: { limits?: ConcurrencyLimits; blobs?: BlobStore } = {},
  ) {
    this.limits = opts.limits ?? limitsFromEnv();
    this.blobs = opts.blobs;
    registry.onMachineOffline = (id) => this.onMachineOffline(id);
  }

  private blobs?: BlobStore;
  private pendingFollowupPrompt = new Map<string, { prompt: string; attachmentIds: string[] }>();
  private askInFlight = new Set<string>();
  private askTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private terminal(status: string): boolean {
    return isStatus(status, ENDED_STATUSES);
  }

  private wsAttachments(ids: string[]): BlobMeta[] | undefined {
    if (!this.blobs || ids.length === 0) return undefined;
    const { items } = this.blobs.metas(ids);
    return items;
  }

  private audit(actor: string, action: string, target: string, payload?: object) {
    this.db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,?2,?3,?4,?5)")
      .run(Date.now(), actor, action, target, payload ? JSON.stringify(payload) : null);
  }

  private setStatus(id: string, status: string, extra: Record<string, unknown> = {}, actor = "hub") {
    const sets = ["status=?2"]; const vals: unknown[] = [id, status];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?${vals.length + 1}`); vals.push(v); }
    if (isStatus(status, ENDED_STATUSES) && !("ended_at" in extra)) {
      sets.push(`ended_at=?${vals.length + 1}`); vals.push(Date.now());
    }
    this.db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id=?1`).run(...vals as any);
    this.blobs?.syncRefsFromRuns();
    if (this.terminal(status) || status !== "running") {
      this.db.query("UPDATE runs SET pending_ask=NULL WHERE id=?1").run(id);
      this.clearAskInFlight(id);
    }
    this.audit(actor, `run.${status}`, id, extra);
    this.sse.broadcast(id, { type: "run.status", runId: id, status });
  }

  private countOccupying(machineId: string, workspaceRoot?: string): number {
    if (workspaceRoot) {
      return (this.db.query(
        `SELECT COUNT(*) AS n FROM runs WHERE machine_id=?1 AND workspace_root=?2 AND status IN (${sqlStatusIn(OCCUPYING_STATUSES)})`,
      ).get(machineId, workspaceRoot) as { n: number }).n;
    }
    return (this.db.query(
      `SELECT COUNT(*) AS n FROM runs WHERE machine_id=?1 AND status IN (${sqlStatusIn(OCCUPYING_STATUSES)})`,
    ).get(machineId) as { n: number }).n;
  }

  private injectSlotCount(machineId: string): number {
    const injectingRuns = (this.db.query(
      `SELECT COUNT(*) AS n FROM runs WHERE machine_id=?1 AND status IN (${sqlStatusIn(INJECTING_STATUSES)})`,
    ).get(machineId) as { n: number }).n;
    const injectingOutbound = (this.db.query(
      `SELECT COUNT(*) AS n FROM run_outbound o JOIN runs r ON r.id=o.run_id
       WHERE r.machine_id=?1 AND o.state='injecting'`,
    ).get(machineId) as { n: number }).n;
    return injectingRuns + injectingOutbound;
  }

  private hasOutstandingOutbound(runId: string): boolean {
    return !!(this.db.query(
      `SELECT 1 AS n FROM run_outbound WHERE run_id=?1 AND state='queued' LIMIT 1`,
    ).get(runId) as { n: number } | null);
  }

  private unconsumedOutboundCount(runId: string): number {
    return (this.db.query(
      `SELECT COUNT(*) AS n FROM run_outbound WHERE run_id=?1 AND state IN ('injecting','queued','steered')`,
    ).get(runId) as { n: number }).n;
  }

  private hasOutboundCollision(runId: string, prompt: string): boolean {
    const key = normalizePrompt(prompt);
    if (!key) return false;
    const rows = this.db.query(
      `SELECT prompt FROM run_outbound WHERE run_id=?1 AND state IN ('injecting','queued','steered')`,
    ).all(runId) as { prompt: string }[];
    return rows.some((r) => normalizePrompt(r.prompt) === key);
  }

  private listVisibleOutbound(runId: string): {
    id: string; prompt: string; expected_mode: string; state: string; created_at: number;
  }[] {
    return this.db.query(
      `SELECT id, prompt, expected_mode, state, created_at FROM run_outbound
       WHERE run_id=?1 AND state IN ('injecting','queued','steered') ORDER BY id ASC`,
    ).all(runId) as { id: string; prompt: string; expected_mode: string; state: string; created_at: number }[];
  }

  private injectingOutbound(runId: string): {
    id: string; expected_mode: string; state: string;
  } | null {
    return (this.db.query(
      `SELECT id, expected_mode, state FROM run_outbound WHERE run_id=?1 AND state='injecting' ORDER BY id DESC LIMIT 1`,
    ).get(runId) as { id: string; expected_mode: string; state: string } | null) ?? null;
  }

  private broadcastOutbound(runId: string, row: { id: string; state: string; expected_mode: string; prompt: string }) {
    this.sse.broadcast(runId, {
      type: "run.outbound", runId, outboundId: row.id, state: row.state, expected_mode: row.expected_mode, prompt: row.prompt,
    });
  }

  private setOutboundState(id: string, state: string): void {
    const row = this.db.query(
      `SELECT id, run_id, prompt, expected_mode FROM run_outbound WHERE id=?1`,
    ).get(id) as { id: string; run_id: string; prompt: string; expected_mode: string } | null;
    if (!row) return;
    this.db.query("UPDATE run_outbound SET state=?1 WHERE id=?2").run(state, id);
    this.broadcastOutbound(row.run_id, { id: row.id, state, expected_mode: row.expected_mode, prompt: row.prompt });
  }

  private failUnconsumedOutbound(runId: string): void {
    const rows = this.db.query(
      `SELECT id FROM run_outbound WHERE run_id=?1 AND state IN ('injecting','queued','steered')`,
    ).all(runId) as { id: string }[];
    for (const r of rows) this.setOutboundState(r.id, "failed");
  }

  private failQueuedOutbound(runId: string): void {
    const rows = this.db.query(
      `SELECT id FROM run_outbound WHERE run_id=?1 AND state='queued'`,
    ).all(runId) as { id: string }[];
    for (const r of rows) this.setOutboundState(r.id, "failed");
  }

  private clearDeferredStop(runId: string): void {
    this.db.query("UPDATE runs SET deferred_stop=NULL WHERE id=?1").run(runId);
  }

  private writeDeferredStop(runId: string, payload: any, live: string | null, reason?: string): void {
    const row = this.db.query("SELECT deferred_stop FROM runs WHERE id=?1").get(runId) as { deferred_stop: string | null } | null;
    let drainedAt = Date.now();
    if (row?.deferred_stop) {
      try {
        const prev = JSON.parse(row.deferred_stop);
        if (genOf(prev?.live_generation_id) === genOf(live) && typeof prev?.drained_at === "number") {
          drainedAt = prev.drained_at;
        }
      } catch { /* keep now */ }
    }
    this.db.query("UPDATE runs SET deferred_stop=?1 WHERE id=?2").run(JSON.stringify({
      payload, live_generation_id: live, drained_at: drainedAt, ...(reason ? { reason } : {}),
    }), runId);
  }

  private maybeReplayDeferredStop(runId: string, opts?: { ignoreOpenChildren?: boolean }): void {
    if (this.hasOutstandingOutbound(runId)) return;
    // Open child jsonl is the BG_DRAIN latch until QUEUE_DRAIN_MS. After that,
    // replay even if Cursor never wrote child turn_ended (r-b770619c orphan).
    if (!opts?.ignoreOpenChildren && this.hasOpenSubagentTranscript(runId)) return;
    const row = this.db.query("SELECT deferred_stop, live_generation_id FROM runs WHERE id=?1").get(runId) as {
      deferred_stop: string | null; live_generation_id: string | null;
    } | null;
    if (!row?.deferred_stop) return;
    let snap: { payload: any; live_generation_id?: string | null; reason?: string };
    try { snap = JSON.parse(row.deferred_stop); } catch {
      this.clearDeferredStop(runId);
      return;
    }
    if (genOf(row.live_generation_id) !== genOf(snap.live_generation_id)) {
      this.clearDeferredStop(runId);
      return;
    }
    this.clearDeferredStop(runId);
    this.onStopEvent(runId, snap.payload, { replayDeferred: !!opts?.ignoreOpenChildren });
  }

  claimOutbound(runId: string, promptNorm: string, eventTs: number): void {
    if (!promptNorm) return;
    const rows = this.db.query(
      `SELECT id, prompt, state, expected_mode, created_at FROM run_outbound
       WHERE run_id=?1 AND state IN ('injecting','queued','steered') ORDER BY id ASC`,
    ).all(runId) as { id: string; prompt: string; state: string; expected_mode: string; created_at: number }[];
    const hit = rows.find((r) => r.created_at <= eventTs && normalizePrompt(r.prompt) === promptNorm);
    if (!hit) return;
    const queueTurn = hit.state === "queued" || (hit.state === "injecting" && hit.expected_mode === "queue");
    const run = this.get(runId);
    if (queueTurn && run?.status === "running" && isWindowsMachineOs(this.registry.getMachine(run.machine_id)?.os)) {
      const routed = this.resolveInjectWindow(run, { requireCdp: false });
      if (!routed.ok) return;
      const windowId = routed.windowId;
      const prev = this.db.query(
        "SELECT live_generation_id, retired_generation_ids, deferred_stop FROM runs WHERE id=?1",
      ).get(runId) as { live_generation_id: string | null; retired_generation_ids: string; deferred_stop: string | null };
      const gen = this.attachHubGeneration(runId, "hub_windows");
      const sent = !!(gen && this.registry.sendTo(run.machine_id, windowId, {
        type: "run.generation", runId, generation_id: gen,
      }));
      if (!sent) {
        this.db.query("UPDATE runs SET live_generation_id=?1, retired_generation_ids=?2, deferred_stop=?3 WHERE id=?4")
          .run(prev.live_generation_id, prev.retired_generation_ids, prev.deferred_stop, runId);
        return;
      }
    }
    this.setOutboundState(hit.id, "consumed");
    if (queueTurn) this.clearDeferredStop(runId);
  }

  private hasPromptCollision(machineId: string, workspaceRoot: string, prompt: string, attachmentIds: string[], exceptId?: string): boolean {
    const key = collisionKey(prompt, attachmentIds);
    const rows = this.db.query(
      `SELECT id, prompt, attachments FROM runs WHERE machine_id=?1 AND workspace_root=?2 AND status IN (${sqlStatusIn(OCCUPYING_STATUSES)})`,
    ).all(machineId, workspaceRoot) as { id: string; prompt: string; attachments: string }[];
    return rows.some((r) => r.id !== exceptId && collisionKey(r.prompt, parseAttachmentIds(r.attachments)) === key);
  }

  private windowHasPendingAsk(machineId: string, windowId: string): boolean {
    const rows = this.db.query(
      `SELECT pending_ask FROM runs WHERE machine_id=?1 AND window_id=?2 AND status IN (${sqlStatusIn(PROGRESSING_STATUSES)}) AND pending_ask IS NOT NULL`,
    ).all(machineId, windowId) as { pending_ask: string }[];
    return rows.some((r) => parsePendingAsk(r.pending_ask) != null);
  }

  private windowCanAcceptStart(machineId: string, windowId: string): boolean {
    if (this.windowHasPendingAsk(machineId, windowId)) return false;
    const ver = this.registry.windowExtensionVersion(machineId, windowId);
    if (extensionSupportsMultiRunPerWindow(ver)) return true;
    const row = this.db.query(
      `SELECT id FROM runs WHERE machine_id=?1 AND window_id=?2 AND status IN (${sqlStatusIn(PROGRESSING_STATUSES)}) LIMIT 1`,
    ).get(machineId, windowId);
    return !row;
  }

  promoteNextQueued(machineId: string): void {
    if (this.promoting) return;
    this.promoting = true;
    const toFail: { id: string; error: string }[] = [];
    try {
      if (this.injectSlotCount(machineId) !== 0) return;
      const rows = this.db.query(
        `SELECT * FROM runs WHERE machine_id=?1 AND status='queued' ORDER BY dispatch_seq ASC`,
      ).all(machineId) as any[];
      for (const row of rows) {
        const m = this.registry.getMachine(machineId);
        const open = m ? JSON.parse(m.open_workspaces) as string[] : [];
        if (!open.includes(row.workspace_root)) {
          toFail.push({ id: row.id, error: "WORKSPACE_NOT_OPEN" });
          continue;
        }
        const routed = this.registry.routeForInject(machineId, row.workspace_root);
        if (!routed.ok) {
          toFail.push({ id: row.id, error: routed.error });
          continue;
        }
        if (!this.windowCanAcceptStart(machineId, routed.windowId)) continue;
        const now = Date.now();
        this.db.query(`UPDATE runs SET status='dispatched', queued_at=NULL, started_at=?1 WHERE id=?2`).run(now, row.id);
        this.audit("hub", "run.dispatched", row.id);
        this.sse.broadcast(row.id, { type: "run.status", runId: row.id, status: "dispatched" });
        this.attachHubGenerationIfWindows(row.id, machineId);
        const live = this.get(row.id);
        this.registry.sendTo(machineId, routed.windowId, this.startMessage(live ?? row, now));
        break;
      }
    } finally {
      this.promoting = false;
    }
    for (const { id, error } of toFail) this.setStatus(id, "error", { end_reason: error });
  }

  private startMessage(row: { id: string; workspace_root: string; prompt: string; attachments?: string; live_generation_id?: string | null }, now: number) {
    const attachments = this.wsAttachments(parseAttachmentIds(row.attachments));
    const gen = genOf(row.live_generation_id);
    return {
      type: "run.start" as const,
      runId: row.id,
      workspaceRoot: row.workspace_root,
      prompt: row.prompt,
      dispatchedAt: now,
      ...(attachments && attachments.length ? { attachments } : {}),
      ...(gen ? { generation_id: gen } : {}),
    };
  }

  /** 签发本轮 hub generation，扩展合成 stop 回显。 */
  private attachHubGeneration(runId: string, source: "hub_windows" | "hub_unarmed"): string | null {
    const run = this.get(runId);
    if (!run) return null;
    const gen = randomUUID();
    const retired = appendRetired(this.retiredState(run), run.live_generation_id);
    this.persistGeneration(runId, gen, retired);
    this.audit("hub", "GEN_ARMED", runId, { generation_id: gen, source });
    return gen;
  }

  /** Windows 无 BSP：dispatch/start 由 hub 签发。Mac 首轮仍只由 BSP 武装。 */
  private attachHubGenerationIfWindows(runId: string, machineId: string): string | null {
    const os = this.registry.getMachine(machineId)?.os;
    if (!isWindowsMachineOs(os)) return null;
    return this.attachHubGeneration(runId, "hub_windows");
  }

  create(machineId: string, workspaceRoot: string, prompt: string,
         opts: { parentRunId?: string; conversationId?: string; via?: "new" | "followup"; attachmentIds?: string[] } = {}) {
    const m = this.registry.getMachine(machineId);
    if (!m || m.status !== "online") return { error: "MACHINE_OFFLINE" };
    if (!JSON.parse(m.open_workspaces).includes(workspaceRoot)) return { error: "WORKSPACE_NOT_OPEN" };
    const routed = this.registry.routeForInject(machineId, workspaceRoot);
    if (!routed.ok) return { error: routed.error };
    const win = { windowId: routed.windowId };

    const attachmentIds = opts.attachmentIds ?? [];
    if (this.blobs && attachmentIds.length) {
      const checked = this.blobs.metas(attachmentIds);
      if (checked.error) return { error: checked.error, status: checked.status };
    } else if (attachmentIds.length && !this.blobs) {
      return { error: "ATTACHMENT_NOT_FOUND" };
    }
    if (!normalizePrompt(prompt) && attachmentIds.length === 0) return { error: "EMPTY_PROMPT" };

    const occupying = this.countOccupying(machineId);
    if (occupying >= this.limits.maxPerMachine) return { error: "RUN_LIMIT" };
    const occupyingWs = this.countOccupying(machineId, workspaceRoot);
    if (occupyingWs >= this.limits.maxPerWorkspace) return { error: "RUN_LIMIT" };

    if (this.hasPromptCollision(machineId, workspaceRoot, prompt, attachmentIds)) return { error: "PROMPT_COLLISION" };

    if (!this.limits.multiRunPerWindow) {
      const sameWindowActive = this.db.query(
        `SELECT id FROM runs WHERE machine_id=?1 AND window_id=?2 AND status IN (${sqlStatusIn(OCCUPYING_STATUSES)}) LIMIT 1`,
      ).get(machineId, win.windowId);
      if (sameWindowActive) return { error: "WINDOW_BUSY" };
    }

    const nextSeq = ((this.db.query(
      `SELECT COALESCE(MAX(dispatch_seq), 0) AS n FROM runs WHERE machine_id=?1`,
    ).get(machineId) as { n: number }).n) + 1;

    const id = `r-${randomUUID()}`;
    const slotFree = this.injectSlotCount(machineId) === 0;
    const canStartNow = slotFree && this.windowCanAcceptStart(machineId, win.windowId);
    const status = canStartNow ? "dispatched" : "queued";
    const now = Date.now();
    const attachmentsJson = JSON.stringify(attachmentIds);
    this.db.query(`INSERT INTO runs (id, machine_id, window_id, workspace_root, prompt, status, conversation_id, parent_run_id, created_at, queued_at, dispatch_seq, attachments)
                   VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`)
      .run(id, machineId, win.windowId, workspaceRoot, prompt, status, opts.conversationId ?? null, opts.parentRunId ?? null, now, status === "queued" ? now : null, nextSeq, attachmentsJson);
    this.blobs?.syncRefsFromRuns();
    this.audit("operator", "run.create", id, { machineId, workspaceRoot, via: opts.via ?? "new", status });
    if (status === "dispatched") {
      this.attachHubGenerationIfWindows(id, machineId);
      this.registry.sendTo(machineId, win.windowId, this.startMessage(this.get(id), now));
      this.audit("hub", "run.dispatched", id);
    }
    const queuePosition = status === "queued"
      ? (this.db.query(`SELECT COUNT(*) AS n FROM runs WHERE machine_id=?1 AND status='queued' AND dispatch_seq<=?2`).get(machineId, nextSeq) as { n: number }).n
      : 0;
    return { run: this.get(id), queuePosition };
  }

  /** 派发其实成功、ack 在 WS 抖动里迟到:允许从 DISPATCH_TIMEOUT 误杀收回。 */
  private isFalseDispatchTimeout(run: { status: string; end_reason: string | null }): boolean {
    return run.status === "error" && run.end_reason === "DISPATCH_TIMEOUT";
  }

  private isFalseBindTimeout(run: { status: string; end_reason: string | null }): boolean {
    return run.status === "unknown" && run.end_reason === "BIND_TIMEOUT";
  }

  private denyReviveIfSlotBusy(machineId: string, runId: string): boolean {
    if (this.injectSlotCount(machineId) === 0) return false;
    this.audit("hub", "inject_slot_revive_denied", runId);
    return true;
  }

  submitPromptMatches(run: { prompt: string; attachments?: string }, hookPrompt: string): boolean {
    return this.promptCompatible(run, hookPrompt);
  }

  private promptCompatible(run: { prompt: string; attachments?: string }, hookPrompt: string): boolean {
    const a = stripImageMarkers(hookPrompt);
    const b = stripImageMarkers(run.prompt ?? "");
    const ids = parseAttachmentIds(run.attachments);
    if (a && a === b) return true;
    if (!a && ids.length > 0 && (hasImageMarkers(hookPrompt) || !b)) return true;
    return false;
  }

  /**
   * 其它窗口误转发、runId 为空时:仅当 prompt 与等待中的任务原文一致才挂靠。
   * 同工作区另一对话的闲聊不得 bind。不含 running。
   */
  findAttachableRun(machineId: string, workspaceRoots: string[], prompt?: string): any | null {
    if (typeof prompt !== "string" || workspaceRoots.length === 0) return null;
    const rows = this.db.query(
      `SELECT * FROM runs WHERE machine_id=?1 ORDER BY created_at DESC`,
    ).all(machineId) as any[];
    const hits = rows.filter((r) => {
      if (!workspacePathIn(r.workspace_root, workspaceRoots)) return false;
      if (!isStatus(r.status, INJECTING_STATUSES) && !this.isFalseBindTimeout(r) && !this.isFalseDispatchTimeout(r)) return false;
      return this.promptCompatible(r, prompt);
    });
    return hits.length === 1 ? hits[0] : null;
  }

  /**
   * 扩展贴图/注入未完成时续命 dispatched 时钟。
   * 30s 只杀「上次 progress 之后再无消息」；贴图中途不得 DISPATCH_TIMEOUT。
   */
  onRunProgress(machineId: string, msg: any) {
    const run = this.get(msg.runId);
    if (!run) return;
    const now = Date.now();
    if (run.status === "dispatched") {
      this.db.query("UPDATE runs SET started_at=?1 WHERE id=?2").run(now, run.id);
      this.audit("extension", "run.progress", run.id, { phase: msg.phase ?? null });
      return;
    }
    if (!this.isFalseDispatchTimeout(run)) return;
    if (this.denyReviveIfSlotBusy(machineId, run.id)) return;
    this.setStatus(run.id, "dispatched", { ended_at: null, end_reason: null, started_at: now }, "extension");
    this.audit("extension", "run.progress", run.id, { phase: msg.phase ?? null, revived: true });
  }

  onRunAck(machineId: string, msg: any) {
    const run = this.get(msg.runId);
    if (!run) return;
    if (this.askInFlight.has(run.id)) {
      this.onAnswerAskAck(run.id, msg);
      return;
    }
    const injecting = this.injectingOutbound(run.id);
    if (injecting) {
      if (this.terminal(run.status) || run.status === "running") {
        if (this.terminal(run.status) || msg.status !== "accepted") {
          this.setOutboundState(injecting.id, "failed");
          if (run.status === "running") this.promoteNextQueued(machineId);
          return;
        }
        const next = injecting.expected_mode === "queue" ? "queued" : "steered";
        this.setOutboundState(injecting.id, next);
        if (next === "steered") this.maybeReplayDeferredStop(run.id);
        this.promoteNextQueued(machineId);
        return;
      }
    }
    const recoverable = this.isFalseDispatchTimeout(run);
    if (run.status !== "dispatched" && !recoverable) return;
    if (recoverable && this.denyReviveIfSlotBusy(machineId, run.id)) return;
    if (msg.status === "accepted") {
      this.setStatus(run.id, "binding", recoverable
        ? { ended_at: null, end_reason: null, started_at: Date.now() }
        : {}, "extension");
      const pending = this.pendingFollowupPrompt.get(run.id);
      if (pending !== undefined) {
        this.pendingFollowupPrompt.delete(run.id);
        this.recordFollowupPrompt(run, pending.prompt, pending.attachmentIds);
      }
    } else {
      this.pendingFollowupPrompt.delete(run.id);
      this.setStatus(run.id, "error", { end_reason: publicRunError(msg.reason ?? "REJECTED") }, "extension");
      this.promoteNextQueued(machineId);
    }
  }

  onRunBound(machineId: string, msg: any) {
    const run = this.get(msg.runId);
    if (!run) return;
    const recoverable = this.isFalseDispatchTimeout(run) || this.isFalseBindTimeout(run);
    if (!isStatus(run.status, INJECTING_STATUSES) && !recoverable) return;
    if (recoverable && this.denyReviveIfSlotBusy(machineId, run.id)) return;
    const cid = typeof msg.conversationId === "string" && msg.conversationId.trim()
      ? msg.conversationId.trim()
      : null;
    if (cid) {
      const other = this.getActiveByConversation(cid);
      if (other && other.id !== run.id) {
        this.onBindAmbiguous(run.id);
        return;
      }
    }
    this.setStatus(run.id, "running", {
      conversation_id: msg.conversationId ?? null,
      transcript_path: msg.transcriptPath ?? null,
      started_at: Date.now(),
      ...(recoverable ? { ended_at: null, end_reason: null } : {}),
    }, "extension");
    this.promoteNextQueued(machineId);
  }

  onBindAmbiguous(runId: string): void {
    const run = this.get(runId);
    if (!run) return;
    if (!isStatus(run.status, INJECTING_STATUSES)) return;
    this.setStatus(run.id, "unknown", { end_reason: "BIND_AMBIGUOUS" }, "extension");
    this.promoteNextQueued(run.machine_id);
  }

  /** Bound window if still connected; else workspace first window. CDP is opt-in, not a third routing rule. */
  private resolveInjectWindow(
    run: { machine_id: string; window_id: string | null; workspace_root: string },
    opts: { requireCdp?: boolean } = {},
  ): InjectRoute {
    const windowId = run.window_id && this.registry.isConnected(run.machine_id, run.window_id)
      ? run.window_id
      : this.registry.findWindowForWorkspace(run.machine_id, run.workspace_root)?.windowId ?? null;
    if (!windowId) return { ok: false, error: "WORKSPACE_NOT_OPEN" };
    if (opts.requireCdp && this.registry.windowCdpReady(run.machine_id, windowId) !== true) {
      return { ok: false, error: "CDP_NOT_READY" };
    }
    return { ok: true, windowId };
  }

  onCancelRequested(runId: string): { error?: string } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    if (run.status === "queued") {
      this.setStatus(runId, "cancelled", { end_reason: "cancelled" }, "operator");
      this.promoteNextQueued(run.machine_id);
      return {};
    }
    if (!(ACTIVE_STATUSES as readonly string[]).includes(run.status)) return { error: "ALREADY_TERMINAL" };
    this.cancelRequested.add(runId);
    this.failUnconsumedOutbound(runId);
    this.clearDeferredStop(runId);
    this.retireLiveGeneration(runId);
    const routed = this.resolveInjectWindow(run, { requireCdp: false });
    const windowId = routed.ok ? routed.windowId : null;
    let sent = false;
    if (run.conversation_id && windowId) {
      if (windowId !== run.window_id) {
        this.db.query("UPDATE runs SET window_id=?1 WHERE id=?2").run(windowId, runId);
      }
      const ask = parsePendingAsk(run.pending_ask);
      if (ask && !isPlanAsk(ask)) {
        this.answerAsk(runId, { request_id: ask.request_id, action: "skip" });
      }
      sent = this.registry.sendTo(run.machine_id, windowId, { type: "run.cancel", runId, conversationId: run.conversation_id });
    }
    this.audit("operator", "run.cancel.requested", runId, { sent, windowId });
    this.setStatus(runId, "cancelled", { end_reason: "cancelled" }, "operator");
    this.promoteNextQueued(run.machine_id);
    return {};
  }

  private isUserAbort(payload: any): boolean {
    const e = String(payload?.error ?? "");
    return /user aborted/i.test(e) || e === "cancelled" || e === "canceled";
  }

  private retiredState(run: { id: string; retired_generation_ids?: string | null; live_generation_id?: string | null }): string[] {
    const parsed = parseRetiredIds(run.retired_generation_ids);
    if (parsed.parseFailed) this.audit("hub", "RETIRED_PARSE_FAIL", run.id, {});
    return parsed.ids;
  }

  private persistGeneration(runId: string, live: string | null, retired: string[]) {
    const prev = this.db.query("SELECT live_generation_id FROM runs WHERE id=?1").get(runId) as { live_generation_id: string | null } | null;
    if (prev && genOf(prev.live_generation_id) !== genOf(live)) this.clearDeferredStop(runId);
    this.db.query("UPDATE runs SET live_generation_id=?1, retired_generation_ids=?2 WHERE id=?3")
      .run(live, JSON.stringify(retired), runId);
  }

  retireLiveGeneration(runId: string): void {
    const run = this.get(runId);
    if (!run) return;
    const retired = appendRetired(this.retiredState(run), run.live_generation_id);
    this.persistGeneration(runId, null, retired);
  }

  tryArmLiveGeneration(runId: string, hookEventName: string | null, payload: any, eventCid: unknown): void {
    const run = this.get(runId);
    if (!run) return;
    const retired = this.retiredState(run);
    const d = decideArm({
      hookEventName,
      generationId: payload?.generation_id,
      eventCid,
      runConversationId: run.conversation_id,
      liveGenerationId: run.live_generation_id ?? null,
      retired,
    });
    if (d.action === "arm") {
      this.persistGeneration(runId, d.gen, retired);
      this.audit("hub", "GEN_ARMED", runId, { generation_id: d.gen });
      return;
    }
    if (d.action === "rearm") {
      this.persistGeneration(runId, d.gen, appendRetired(retired, d.retire));
      this.audit("hub", "GEN_ARMED", runId, { generation_id: d.gen, retired: d.retire });
      return;
    }
    if (d.reason === "already_armed_same") return;
    if (hookEventName === "preToolUse" && (d.reason === "cid_mismatch" || d.reason === "sidecar_gen")) return;
    this.audit("hub", "GEN_ARMED_SKIP", runId, { reason: d.reason, generation_id: payload?.generation_id ?? null });
  }

  private hasHubFollowup(runId: string): boolean {
    const row = this.db.query(
      `SELECT 1 AS n FROM run_events WHERE run_id=?1 AND source='hub' AND hook_event_name='beforeSubmitPrompt' LIMIT 1`,
    ).get(runId) as { n: number } | null;
    return !!row;
  }

  private liveTurnSettled(runId: string, live: string | null): boolean {
    if (!live) return false;
    const row = this.db.query(
      `SELECT 1 AS n FROM run_events WHERE run_id=?1 AND hook_event_name='afterAgentResponse'
       AND json_extract(payload, '$.generation_id')=?2 LIMIT 1`,
    ).get(runId, live) as { n: number } | null;
    return !!row;
  }

  private hasOpenSubagentTranscript(runId: string): boolean {
    const row = this.db.query(
      `SELECT 1 AS n FROM run_events e
       JOIN runs r ON r.id = e.run_id
       WHERE e.run_id=?1 AND e.source='subagent-transcript'
         AND json_extract(e.payload, '$.__subagent_cid') IS NOT NULL
         AND json_extract(e.payload, '$.__subagent_cid') != ''
         AND e.ts >= COALESCE(r.started_at, r.created_at)
         AND NOT EXISTS (
           SELECT 1 FROM run_events t
           WHERE t.run_id=e.run_id AND t.source='subagent-transcript'
             AND json_extract(t.payload, '$.__subagent_cid') = json_extract(e.payload, '$.__subagent_cid')
             AND json_extract(t.payload, '$.type') = 'turn_ended'
         )
       LIMIT 1`,
    ).get(runId) as { n: number } | null;
    return !!row;
  }

  private backgroundDrainHold(runId: string, live: string | null): boolean {
    if (!live) return false;
    const row = this.db.query("SELECT deferred_stop FROM runs WHERE id=?1").get(runId) as { deferred_stop: string | null } | null;
    if (!row?.deferred_stop) return false;
    try {
      const snap = JSON.parse(row.deferred_stop);
      return snap?.reason === "BG_DRAIN" && genOf(snap?.live_generation_id) === live;
    } catch {
      return false;
    }
  }

  private hasOutstandingBackground(runId: string, live: string | null): boolean {
    return this.hasOpenSubagentTranscript(runId) || this.backgroundDrainHold(runId, live);
  }

  onStopEvent(runId: string, payload: any, opts?: { replayDeferred?: boolean }) {
    const run = this.get(runId);
    if (!run) return;
    // BIND_TIMEOUT / DISPATCH_TIMEOUT 误杀后真实事件仍可能到达
    const recoverable = this.isFalseBindTimeout(run) || this.isFalseDispatchTimeout(run);
    if (!(ACTIVE_STATUSES as readonly string[]).includes(run.status) && !recoverable) return;
    const retired = this.retiredState(run);
    const live = genOf(run.live_generation_id);
    const d = decideStop({
      stopCid: payload?.conversation_id,
      runConversationId: run.conversation_id,
      stopGenerationId: payload?.generation_id,
      liveGenerationId: run.live_generation_id ?? null,
      hasHubFollowup: this.hasHubFollowup(runId),
      retired,
      liveTurnSettled: this.liveTurnSettled(runId, live),
      hasOutstandingOutbound: this.hasOutstandingOutbound(runId),
      hasOutstandingBackground: opts?.replayDeferred ? false : this.hasOutstandingBackground(runId, live),
      stopStatus: payload?.status,
    });
    if (d.action === "ignore") {
      if (d.audit === "QUEUE_DRAIN") this.writeDeferredStop(runId, payload, live);
      if (d.audit === "BG_DRAIN") this.writeDeferredStop(runId, payload, live, "BG_DRAIN");
      this.audit("hub", d.audit, runId, { live: run.live_generation_id ?? null, stop: payload?.generation_id ?? null });
      return;
    }
    if (d.audit === "STOP_NO_GEN_INITIAL") this.audit("hub", "STOP_NO_GEN_INITIAL", runId, {});
    if (d.audit === "STOP_SESSION_GEN") this.audit("hub", "STOP_SESSION_GEN", runId, { live, stop: payload?.generation_id ?? null });
    const s = payload?.status;
    const abortive = s === "aborted" || s === "error" || this.cancelRequested.has(runId);
    if (abortive) {
      this.failUnconsumedOutbound(runId);
      this.clearDeferredStop(runId);
    }
    if (s === "completed" || s === "success") this.setStatus(runId, "completed", { end_reason: "completed" }, "extension");
    else if (s === "aborted") {
      const wasCancel = this.cancelRequested.has(runId);
      this.setStatus(runId, wasCancel ? "cancelled" : "aborted", { end_reason: wasCancel ? "cancelled" : "aborted" }, "extension");
    } else if (s === "error") {
      if (this.cancelRequested.has(runId)) {
        this.setStatus(runId, "cancelled", { end_reason: "cancelled" }, "extension");
      } else if (this.isUserAbort(payload)) {
        this.setStatus(runId, "aborted", { end_reason: "aborted" }, "extension");
      } else {
        this.setStatus(runId, "error", { end_reason: payload?.error ?? "error" }, "extension");
      }
    } else {
      return;
    }
    this.persistGeneration(runId, null, appendRetired(retired, run.live_generation_id));
    this.cancelRequested.delete(runId);
    this.promoteNextQueued(run.machine_id);
  }

  sweepTimeouts(now = Date.now()) {
    // 超时锚点 = 最近一次派发时刻:续聊会把 started_at 重置。
    // 若用 created_at,老卡片 followup 后会立刻 BIND_TIMEOUT(真机:created 8:41,续聊 9:05,1s 后进未知)。
    const age = (r: { created_at: number; started_at: number | null }) => now - (r.started_at ?? r.created_at);
    const machines = new Set<string>();
    const d = this.db.query("SELECT id, machine_id, created_at, started_at FROM runs WHERE status='dispatched'").all() as any[];
    for (const r of d) if (age(r) > DISPATCH_TIMEOUT_MS) {
      this.setStatus(r.id, "error", { end_reason: "DISPATCH_TIMEOUT" });
      machines.add(r.machine_id);
    }
    const b = this.db.query("SELECT id, machine_id, created_at, started_at FROM runs WHERE status='binding'").all() as any[];
    for (const r of b) {
      const os = this.registry.getMachine(r.machine_id)?.os;
      const limit = isWindowsMachineOs(os) ? WINDOWS_BIND_TIMEOUT_MS : BIND_TIMEOUT_MS;
      if (age(r) > limit) {
        this.setStatus(r.id, "unknown", { end_reason: "BIND_TIMEOUT" });
        machines.add(r.machine_id);
      }
    }
    const inj = this.db.query(
      `SELECT o.id, r.machine_id FROM run_outbound o JOIN runs r ON r.id=o.run_id
       WHERE o.state='injecting' AND o.created_at < ?1`,
    ).all(now - DISPATCH_TIMEOUT_MS) as { id: string; machine_id: string }[];
    for (const r of inj) {
      this.setOutboundState(r.id, "failed");
      machines.add(r.machine_id);
    }
    const drained = this.db.query(
      `SELECT id, deferred_stop FROM runs WHERE deferred_stop IS NOT NULL`,
    ).all() as { id: string; deferred_stop: string }[];
    for (const r of drained) {
      let snap: { drained_at?: number; reason?: string };
      try { snap = JSON.parse(r.deferred_stop); } catch { continue; }
      if (typeof snap.drained_at !== "number" || now - snap.drained_at < QUEUE_DRAIN_MS) continue;
      this.failQueuedOutbound(r.id);
      this.maybeReplayDeferredStop(r.id, { ignoreOpenChildren: snap.reason === "BG_DRAIN" });
    }
    this.replayCursorSessionEndStops();
    for (const machineId of machines) this.promoteNextQueued(machineId);
  }

  /** Latest Cursor sessionEnd on a live run. `generating` stays busy; teardown maps to stop. */
  private replayCursorSessionEndStops(): void {
    const live = this.db.query(
      `SELECT id FROM runs WHERE status IN (${sqlStatusIn(PROGRESSING_STATUSES)})`,
    ).all() as { id: string }[];
    for (const r of live) {
      const row = this.db.query(
        `SELECT seq, payload FROM run_events
         WHERE run_id=?1 AND hook_event_name='sessionEnd'
         ORDER BY seq DESC LIMIT 1`,
      ).get(r.id) as { seq: number; payload: string } | null;
      if (!row) continue;
      const last = this.sessionEndReplaySeq.get(r.id);
      if (last != null && row.seq <= last) continue;
      this.sessionEndReplaySeq.set(r.id, row.seq);
      let payload: unknown;
      try { payload = JSON.parse(row.payload); } catch { continue; }
      const mapped = stopFromCursorSessionEnd(payload);
      if (mapped) this.onStopEvent(r.id, mapped);
    }
  }

  onMachineOffline(machineId: string) {
    const rows = this.db.query(
      `SELECT id, status FROM runs WHERE machine_id=?1 AND status IN (${sqlStatusIn(OCCUPYING_STATUSES)})`
    ).all(machineId) as any[];
    for (const r of rows) {
      this.failUnconsumedOutbound(r.id);
      this.clearDeferredStop(r.id);
      if (r.status === "queued") this.setStatus(r.id, "cancelled", { end_reason: "MACHINE_OFFLINE" });
      else this.setStatus(r.id, "unknown", { end_reason: "MACHINE_OFFLINE" });
    }
    this.promoteNextQueued(machineId);
  }

  private hydrateRun(row: any): any {
    if (!row) return row;
    const { deferred_stop: _deferred, ...rest } = row;
    const mode = this.registry.getMachine(row.machine_id)?.queue_message_default_behavior ?? null;
    return {
      ...rest,
      pending_ask: parsePendingAsk(row.pending_ask),
      outbound: this.listVisibleOutbound(row.id),
      queue_message_default_behavior: mode,
      window_connected: !!(row.window_id && this.registry.isConnected(row.machine_id, row.window_id)),
      attachment_items: this.wsAttachments(parseAttachmentIds(row.attachments)) ?? [],
    };
  }

  list(status?: string, machineId?: string, archived?: string) {
    let sql = "SELECT * FROM runs WHERE 1=1"; const args: string[] = [];
    if (status) { sql += " AND status=?"; args.push(status); }
    if (machineId) { sql += " AND machine_id=?"; args.push(machineId); }
    if (archived === "1") sql += " AND archived_at IS NOT NULL";
    else if (archived !== "all") sql += " AND archived_at IS NULL";
    return (this.db.query(sql + " ORDER BY created_at DESC").all(...args) as any[]).map((r) => this.hydrateRun(r));
  }

  get(id: string): any {
    return this.hydrateRun(this.db.query("SELECT * FROM runs WHERE id=?1").get(id) ?? null);
  }

  getByConversation(cid: string): any {
    return this.hydrateRun(this.db.query("SELECT * FROM runs WHERE conversation_id=?1 ORDER BY created_at DESC LIMIT 1").get(cid) ?? null);
  }

  getActiveByConversation(cid: string): any {
    return this.hydrateRun(this.db.query(
      `SELECT * FROM runs WHERE conversation_id=?1 AND status IN (${sqlStatusIn(ACTIVE_STATUSES)})
       ORDER BY created_at DESC LIMIT 1`,
    ).get(cid) ?? null);
  }

  private clearAskInFlight(id: string): void {
    this.askInFlight.delete(id);
    const t = this.askTimers.get(id);
    if (t) clearTimeout(t);
    this.askTimers.delete(id);
  }

  private onAnswerAskAck(runId: string, msg: any): void {
    this.clearAskInFlight(runId);
    if (msg.status === "accepted") return;
    this.sse.broadcast(runId, {
      type: "run.ask", runId, state: "submit_failed", error: msg.reason ?? "REJECTED",
    });
  }

  applyAskQuestion(runId: string, payload: unknown): void {
    const run = this.get(runId);
    if (!run) return;
    const incoming = parsePendingAsk(payload);
    if (!incoming) return;
    if (run.status !== "running") {
      if (!isPlanAsk(incoming) || run.status !== "completed") return;
      this.setStatus(runId, "running", { ended_at: null, end_reason: null });
    }
    const existing = parsePendingAsk(this.get(runId)?.pending_ask);
    const next = mergePendingAskRecord(existing, incoming);
    this.db.query("UPDATE runs SET pending_ask=?1 WHERE id=?2").run(JSON.stringify(next), runId);
    this.audit("extension", "run.pending_ask", runId, { request_id: next.request_id });
    this.sse.broadcast(runId, { type: "run.status", runId, status: "running" });
  }

  resolveAskQuestion(runId: string, requestId?: unknown): void {
    const run = this.get(runId);
    if (!run) return;
    const pending = parsePendingAsk(run.pending_ask);
    if (!pending) return;
    if (typeof requestId === "string" && requestId && requestId !== pending.request_id) return;
    this.clearAskInFlight(runId);
    this.db.query("UPDATE runs SET pending_ask=NULL WHERE id=?1").run(runId);
    this.sse.broadcast(runId, { type: "run.status", runId, status: run.status });
    this.promoteNextQueued(run.machine_id);
  }

  answerAsk(runId: string, body: any): { error?: string; run?: any; already?: boolean } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    const request_id = typeof body?.request_id === "string" ? body.request_id.trim() : "";
    const ask = parsePendingAsk(run.pending_ask);
    if (!ask) {
      if (request_id && this.wasAskResolved(runId, request_id)) return { already: true };
      return { error: "NO_PENDING_ASK" };
    }
    if (run.status !== "running") return { error: "NO_PENDING_ASK" };
    if (!request_id || request_id !== ask.request_id) return { error: "ASK_MISMATCH" };
    const action = body?.action === "skip" ? "skip"
      : body?.action === "continue" ? "continue"
      : body?.action === "freeform" ? "freeform"
      : "";
    if (!action) return { error: "ASK_INVALID_OPTION" };
    if ((action === "skip" || action === "freeform") && isPlanAsk(ask)) return { error: "ASK_INVALID_OPTION" };
    let answers: { question_id: string; option_ids: string[] }[] = [];
    let text: string | undefined;
    if (action === "continue") {
      if (!continueAllowed(ask)) return { error: "ASK_INVALID_OPTION" };
      const raw = Array.isArray(body?.answers) ? body.answers : [];
      const first = raw[0] as Record<string, unknown> | undefined;
      const qid = typeof first?.question_id === "string" && first.question_id.trim()
        ? first.question_id.trim()
        : ask.questions[0].id;
      const option_ids = Array.isArray(first?.option_ids)
        ? first.option_ids.filter((x): x is string => typeof x === "string" && x.trim() !== "")
        : [];
      if (option_ids.length !== 1) return { error: "ASK_INVALID_OPTION" };
      if (!optionInAsk(ask, qid, option_ids[0])) return { error: "ASK_INVALID_OPTION" };
      answers = [{ question_id: qid, option_ids }];
    } else if (action === "freeform") {
      if (!continueAllowed(ask)) return { error: "ASK_INVALID_OPTION" };
      const rawText = typeof body?.text === "string" ? body.text.trim() : "";
      if (!rawText) return { error: "ASK_TEXT_EMPTY" };
      if (rawText.length > ASK_TEXT_MAX) return { error: "ASK_TEXT_TOO_LONG" };
      text = rawText;
    }
    if (this.askInFlight.has(runId)) return { error: "ASK_IN_FLIGHT" };
    const routed = this.resolveInjectWindow(run, { requireCdp: true });
    if (!routed.ok) return { error: routed.error };

    this.askInFlight.add(runId);
    const t = setTimeout(() => {
      if (!this.askInFlight.has(runId)) return;
      this.clearAskInFlight(runId);
      this.sse.broadcast(runId, { type: "run.ask", runId, state: "submit_failed", error: "ASK_SUBMIT_FAILED" });
    }, 15_000);
    if (typeof (t as any).unref === "function") (t as any).unref();
    this.askTimers.set(runId, t);

    this.registry.sendTo(run.machine_id, routed.windowId, {
      type: "run.answerAsk",
      runId,
      conversationId: run.conversation_id,
      workspaceRoot: run.workspace_root,
      request_id: ask.request_id,
      action,
      answers,
      ...(text ? { text } : {}),
      ...(ask.kind === "plan" ? { kind: "plan" as const } : {}),
    });
    this.audit("operator", "run.answerAsk", runId, {
      request_id: ask.request_id, action, option_ids: answers[0]?.option_ids ?? [],
    });
    return { run: this.get(runId) };
  }

  private wasAskResolved(runId: string, requestId: string): boolean {
    const rows = this.db.query(
      `SELECT payload FROM run_events WHERE run_id=?1 AND hook_event_name='askQuestionResolved' ORDER BY seq DESC LIMIT 20`,
    ).all(runId) as { payload: string }[];
    return rows.some((r) => {
      try {
        const p = JSON.parse(r.payload);
        return p?.request_id === requestId;
      } catch { return false; }
    });
  }

  /** Windows 往往没有 beforeSubmitPrompt；hub 先落一条用户句，详情才不会丢续聊原文。 */
  private recordFollowupPrompt(run: { id: string; machine_id: string }, prompt: string, attachmentIds: string[] = []): void {
    const maxSeq = (this.db.query("SELECT COALESCE(MAX(seq),0) AS m FROM run_events WHERE run_id=?1").get(run.id) as { m: number }).m;
    const minExt = (this.db.query("SELECT MIN(ext_seq) AS m FROM run_events WHERE machine_id=?1").get(run.machine_id) as { m: number | null }).m;
    const extSeq = minExt == null || minExt >= 0 ? -1 : minExt - 1;
    const ts = Date.now();
    const body = attachmentIds.length ? { prompt, attachmentIds } : { prompt };
    const payload = JSON.stringify(body);
    this.db.query(
      `INSERT INTO run_events (run_id, seq, machine_id, ext_seq, source, hook_event_name, payload, ts, post_terminal)
       VALUES (?1,?2,?3,?4,'hub','beforeSubmitPrompt',?5,?6,0)`,
    ).run(run.id, maxSeq + 1, run.machine_id, extSeq, payload, ts);
    this.sse.broadcast(run.id, {
      type: "run.event", runId: run.id, seq: maxSeq + 1, hookEventName: "beforeSubmitPrompt", payload: body, ts,
    });
  }

  /**
   * 续聊:同一张卡片回到 dispatched,事件继续追加。不新建 child run。
   * 本卡仍占用中 → CONVERSATION_BUSY；注入槽被其它 run 占用 → INJECT_SLOT_BUSY。
   * 同工作区其它卡已在 running 不拦：注入串行、生成并行。
   */
  followup(runId: string, prompt: string, attachmentIds: string[] = []): { error?: string; run?: any } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    if (!run.conversation_id) return { error: "NO_CONVERSATION" };
    if (run.end_reason === "OPERATOR_CLOSED") return { error: "CLOSED" };
    if (run.status === "running") return this.followupWhileRunning(run, prompt, attachmentIds);
    if ((OCCUPYING_STATUSES as readonly string[]).includes(run.status)) return { error: "CONVERSATION_BUSY" };
    if (this.injectSlotCount(run.machine_id) > 0) return { error: "INJECT_SLOT_BUSY" };
    const routed = this.resolveInjectWindow(run, { requireCdp: true });
    if (!routed.ok) return { error: routed.error };
    const win = { windowId: routed.windowId };

    if (this.blobs && attachmentIds.length) {
      const checked = this.blobs.metas(attachmentIds);
      if (checked.error) return { error: checked.error };
    } else if (attachmentIds.length && !this.blobs) {
      return { error: "ATTACHMENT_NOT_FOUND" };
    }
    if (!normalizePrompt(prompt) && attachmentIds.length === 0) return { error: "EMPTY_PROMPT" };
    if (this.hasPromptCollision(run.machine_id, run.workspace_root, prompt, attachmentIds, runId)) {
      return { error: "PROMPT_COLLISION" };
    }

    this.setStatus(runId, "dispatched", {
      ended_at: null, end_reason: null, started_at: Date.now(), window_id: win.windowId,
      prompt, attachments: JSON.stringify(attachmentIds),
    });
    // Mac live 非空不得退役，等 owner BSP rearm。live 已空（含完成后续聊）签发 hub gen：
    // 协议续轮若吞掉 composer BSP，synth stop 会盖上已退役 gen → STOP_GEN_RETIRED 卡死运行中。
    const os = this.registry.getMachine(run.machine_id)?.os;
    if (isWindowsMachineOs(os) || !genOf(run.live_generation_id)) {
      this.attachHubGeneration(runId, isWindowsMachineOs(os) ? "hub_windows" : "hub_unarmed");
    }
    this.cancelRequested.delete(runId);
    if (attachmentIds.length === 0) this.recordFollowupPrompt({ id: runId, machine_id: run.machine_id }, prompt);
    else this.pendingFollowupPrompt.set(runId, { prompt, attachmentIds });

    const live = this.get(runId);
    const gen = genOf(live?.live_generation_id);
    const attachments = this.wsAttachments(attachmentIds);
    this.registry.sendTo(run.machine_id, win.windowId, {
      type: "run.followup", runId, conversationId: run.conversation_id, workspaceRoot: run.workspace_root, prompt,
      ...(attachments && attachments.length ? { attachments } : {}),
      ...(gen ? { generation_id: gen } : {}),
    });
    this.audit("hub", "run.followup", runId, { prompt: prompt.slice(0, 80) });
    return { run: this.get(runId) };
  }

  private followupWhileRunning(run: any, prompt: string, attachmentIds: string[]): { error?: string; run?: any } {
    if (parsePendingAsk(run.pending_ask)) return { error: "CONVERSATION_BUSY" };
    if (attachmentIds.length > 0) return { error: "OUTBOUND_TEXT_ONLY" };
    if (!normalizePrompt(prompt)) return { error: "EMPTY_PROMPT" };
    if (this.injectSlotCount(run.machine_id) > 0) return { error: "INJECT_SLOT_BUSY" };
    if (this.hasPromptCollision(run.machine_id, run.workspace_root, prompt, attachmentIds, run.id)) {
      return { error: "PROMPT_COLLISION" };
    }
    if (this.hasOutboundCollision(run.id, prompt)) return { error: "PROMPT_COLLISION" };
    if (this.unconsumedOutboundCount(run.id) >= OUTBOUND_LIMIT) return { error: "OUTBOUND_LIMIT" };
    const routed = this.resolveInjectWindow(run, { requireCdp: true });
    if (!routed.ok) return { error: routed.error };
    const win = { windowId: routed.windowId };

    const expected_mode = queueModeOf(this.registry.getMachine(run.machine_id)?.queue_message_default_behavior);
    const id = `o-${randomUUID()}`;
    const now = Date.now();
    this.db.query(
      `INSERT INTO run_outbound (id, run_id, prompt, attachments, expected_mode, state, created_at)
       VALUES (?1,?2,?3,'[]',?4,'injecting',?5)`,
    ).run(id, run.id, prompt, expected_mode, now);
    this.broadcastOutbound(run.id, { id, state: "injecting", expected_mode, prompt });
    this.registry.sendTo(run.machine_id, win.windowId, {
      type: "run.followup",
      runId: run.id,
      conversationId: run.conversation_id,
      workspaceRoot: run.workspace_root,
      prompt,
      live: true,
    });
    this.audit("hub", "run.followup.live", run.id, { outboundId: id, expected_mode, prompt: prompt.slice(0, 80) });
    return { run: this.get(run.id) };
  }

  /** 操作员改卡片展示标题。只写 runs.title，不改 prompt / cid，不派发。 */
  rename(runId: string, title: string): { error?: string; run?: any } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    const next = title.trim();
    if (!next) return { error: "EMPTY_PROMPT" };
    this.db.query("UPDATE runs SET title=?1 WHERE id=?2").run(next, runId);
    this.audit("operator", "run.rename", runId, { title: next.slice(0, 80) });
    this.sse.broadcast(runId, { type: "run.status", runId, status: run.status });
    return { run: this.get(runId) };
  }

  /**
   * 失败 / 未知 / 中止：同一张卡再跑。
   * 已绑 cid → 当续聊（run.followup）；从未绑定 → 当新派发（run.start）。
   */
  retry(runId: string): { error?: string; run?: any } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    if (!canRetryStatus(run.status)) return { error: "INVALID_STATE" };
    const ids = parseAttachmentIds(run.attachments);
    this.audit("operator", "run.retry", runId, { via: run.conversation_id ? "followup" : "start" });
    if (run.conversation_id) return this.followup(runId, run.prompt ?? "", ids);
    return this.redispatchFailed(run, ids);
  }

  private redispatchFailed(run: any, attachmentIds: string[]): { error?: string; run?: any } {
    const m = this.registry.getMachine(run.machine_id);
    if (!m || m.status !== "online") return { error: "MACHINE_OFFLINE" };
    if (!JSON.parse(m.open_workspaces).includes(run.workspace_root)) return { error: "WORKSPACE_NOT_OPEN" };
    const routed = this.registry.routeForInject(run.machine_id, run.workspace_root);
    if (!routed.ok) return { error: routed.error };
    const win = { windowId: routed.windowId };
    if (!normalizePrompt(run.prompt ?? "") && attachmentIds.length === 0) return { error: "EMPTY_PROMPT" };
    if (this.countOccupying(run.machine_id) >= this.limits.maxPerMachine) return { error: "RUN_LIMIT" };
    if (this.countOccupying(run.machine_id, run.workspace_root) >= this.limits.maxPerWorkspace) return { error: "RUN_LIMIT" };
    if (this.hasPromptCollision(run.machine_id, run.workspace_root, run.prompt ?? "", attachmentIds, run.id)) {
      return { error: "PROMPT_COLLISION" };
    }
    if (!this.limits.multiRunPerWindow) {
      const sameWindowActive = this.db.query(
        `SELECT id FROM runs WHERE machine_id=?1 AND window_id=?2 AND status IN (${sqlStatusIn(OCCUPYING_STATUSES)}) LIMIT 1`,
      ).get(run.machine_id, win.windowId);
      if (sameWindowActive) return { error: "WINDOW_BUSY" };
    }
    const nextSeq = ((this.db.query(
      `SELECT COALESCE(MAX(dispatch_seq), 0) AS n FROM runs WHERE machine_id=?1`,
    ).get(run.machine_id) as { n: number }).n) + 1;
    const slotFree = this.injectSlotCount(run.machine_id) === 0;
    const canStartNow = slotFree && this.windowCanAcceptStart(run.machine_id, win.windowId);
    const now = Date.now();
    this.cancelRequested.delete(run.id);
    this.retireLiveGeneration(run.id);
    if (canStartNow) {
      this.setStatus(run.id, "dispatched", {
        ended_at: null, end_reason: null, started_at: now, window_id: win.windowId,
        queued_at: null, dispatch_seq: nextSeq,
      });
      this.attachHubGenerationIfWindows(run.id, run.machine_id);
      const live = this.get(run.id);
      this.registry.sendTo(run.machine_id, win.windowId, this.startMessage(live ?? run, now));
    } else {
      this.setStatus(run.id, "queued", {
        ended_at: null, end_reason: null, started_at: null, window_id: win.windowId,
        queued_at: now, dispatch_seq: nextSeq,
      });
    }
    return { run: this.get(run.id) };
  }

  /** Operator close: only error/unknown → cancelled (SSE + audit via setStatus). */
  close(runId: string): { error?: string; run?: any } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    if (!["error", "unknown"].includes(run.status)) return { error: "INVALID_STATE" };
    this.setStatus(runId, "cancelled", { end_reason: "OPERATOR_CLOSED" }, "operator");
    return { run: this.get(runId) };
  }

  /** 中台隐藏卡片，不删数据、不碰 Cursor 会话。运行中不可藏。 */
  archive(runId: string): { error?: string; run?: any } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    if ((OCCUPYING_STATUSES as readonly string[]).includes(run.status)) return { error: "INVALID_STATE" };
    if (run.archived_at) return { run };
    this.db.query("UPDATE runs SET archived_at=?1 WHERE id=?2").run(Date.now(), runId);
    this.audit("operator", "run.archive", runId);
    this.sse.broadcast(runId, { type: "run.archived", runId, archived: true });
    return { run: this.get(runId) };
  }

  unarchive(runId: string): { error?: string; run?: any } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    this.db.query("UPDATE runs SET archived_at=NULL WHERE id=?1").run(runId);
    this.audit("operator", "run.unarchive", runId);
    this.sse.broadcast(runId, { type: "run.archived", runId, archived: false });
    return { run: this.get(runId) };
  }
}
