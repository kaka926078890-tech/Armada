import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { Registry } from "./registry";
import type { SseHub } from "./sse";
import {
  type ConcurrencyLimits,
  limitsFromEnv,
  normalizePrompt,
  extensionSupportsMultiRunPerWindow,
  OCCUPYING_STATUSES,
} from "./concurrency";
import { workspacePathIn } from "../../extension/src/workspacePath";
import { userPromptFromEventPayload } from "../../extension/src/transcriptBind";
import { collisionKey, hasImageMarkers, stripImageMarkers } from "../../extension/src/imageMarkers";
import { BlobStore, parseAttachmentIds, type BlobMeta } from "./blobs";

const ACTIVE = ["created", "dispatched", "binding", "running"];
const DISPATCH_TIMEOUT_MS = 30_000;
const BIND_TIMEOUT_MS = 60_000;

export class RunService {
  private cancelRequested = new Set<string>();
  private promoting = false;
  private limits: ConcurrencyLimits;

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

  private terminal(status: string): boolean {
    return ["completed", "aborted", "error", "cancelled", "unknown"].includes(status);
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
    const prev = this.get(id);
    if (prev && this.terminal(status) && !this.terminal(prev.status) && this.blobs) {
      this.blobs.applyRefDelta(parseAttachmentIds(prev.attachments), []);
    }
    const sets = ["status=?2"]; const vals: unknown[] = [id, status];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?${vals.length + 1}`); vals.push(v); }
    if (["completed", "aborted", "error", "cancelled", "unknown"].includes(status) && !("ended_at" in extra)) {
      sets.push(`ended_at=?${vals.length + 1}`); vals.push(Date.now());
    }
    this.db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id=?1`).run(...vals as any);
    this.audit(actor, `run.${status}`, id, extra);
    this.sse.broadcast(id, { type: "run.status", runId: id, status });
  }

  private countOccupying(machineId: string, workspaceRoot?: string): number {
    if (workspaceRoot) {
      return (this.db.query(
        `SELECT COUNT(*) AS n FROM runs WHERE machine_id=?1 AND workspace_root=?2 AND status IN ('queued','dispatched','binding','running')`,
      ).get(machineId, workspaceRoot) as { n: number }).n;
    }
    return (this.db.query(
      `SELECT COUNT(*) AS n FROM runs WHERE machine_id=?1 AND status IN ('queued','dispatched','binding','running')`,
    ).get(machineId) as { n: number }).n;
  }

  private injectSlotCount(machineId: string): number {
    return (this.db.query(
      `SELECT COUNT(*) AS n FROM runs WHERE machine_id=?1 AND status IN ('dispatched','binding')`,
    ).get(machineId) as { n: number }).n;
  }

  private hasPromptCollision(machineId: string, workspaceRoot: string, prompt: string, attachmentIds: string[], exceptId?: string): boolean {
    const key = collisionKey(prompt, attachmentIds);
    const rows = this.db.query(
      `SELECT id, prompt, attachments FROM runs WHERE machine_id=?1 AND workspace_root=?2 AND status IN ('queued','dispatched','binding','running')`,
    ).all(machineId, workspaceRoot) as { id: string; prompt: string; attachments: string }[];
    return rows.some((r) => r.id !== exceptId && collisionKey(r.prompt, parseAttachmentIds(r.attachments)) === key);
  }

  private windowCanAcceptStart(machineId: string, windowId: string): boolean {
    const ver = this.registry.windowExtensionVersion(machineId, windowId);
    if (extensionSupportsMultiRunPerWindow(ver)) return true;
    const row = this.db.query(
      `SELECT id FROM runs WHERE machine_id=?1 AND window_id=?2 AND status IN ('dispatched','binding','running') LIMIT 1`,
    ).get(machineId, windowId);
    return !row;
  }

  promoteNextQueued(machineId: string): void {
    if (this.promoting) return;
    this.promoting = true;
    const toFail: string[] = [];
    try {
      if (this.injectSlotCount(machineId) !== 0) return;
      const rows = this.db.query(
        `SELECT * FROM runs WHERE machine_id=?1 AND status='queued' ORDER BY dispatch_seq ASC`,
      ).all(machineId) as any[];
      for (const row of rows) {
        const m = this.registry.getMachine(machineId);
        const open = m ? JSON.parse(m.open_workspaces) as string[] : [];
        const win = this.registry.findWindowForWorkspace(machineId, row.workspace_root);
        if (!open.includes(row.workspace_root) || !win) {
          toFail.push(row.id);
          continue;
        }
        if (!this.windowCanAcceptStart(machineId, win.windowId)) continue;
        const now = Date.now();
        this.db.query(`UPDATE runs SET status='dispatched', queued_at=NULL, started_at=?1 WHERE id=?2`).run(now, row.id);
        this.audit("hub", "run.dispatched", row.id);
        this.sse.broadcast(row.id, { type: "run.status", runId: row.id, status: "dispatched" });
        this.registry.sendTo(machineId, win.windowId, this.startMessage(row, now));
        break;
      }
    } finally {
      this.promoting = false;
    }
    for (const id of toFail) this.setStatus(id, "error", { end_reason: "WORKSPACE_NOT_OPEN" });
  }

  private startMessage(row: { id: string; workspace_root: string; prompt: string; attachments?: string }, now: number) {
    const attachments = this.wsAttachments(parseAttachmentIds(row.attachments));
    return {
      type: "run.start" as const,
      runId: row.id,
      workspaceRoot: row.workspace_root,
      prompt: row.prompt,
      dispatchedAt: now,
      ...(attachments && attachments.length ? { attachments } : {}),
    };
  }

  create(machineId: string, workspaceRoot: string, prompt: string,
         opts: { parentRunId?: string; conversationId?: string; via?: "new" | "followup"; attachmentIds?: string[] } = {}) {
    const m = this.registry.getMachine(machineId);
    if (!m || m.status !== "online") return { error: "MACHINE_OFFLINE" };
    if (!JSON.parse(m.open_workspaces).includes(workspaceRoot)) return { error: "WORKSPACE_NOT_OPEN" };
    const win = this.registry.findWindowForWorkspace(machineId, workspaceRoot);
    if (!win) return { error: "WORKSPACE_NOT_OPEN" };

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
        `SELECT id FROM runs WHERE machine_id=?1 AND window_id=?2 AND status IN ('queued','dispatched','binding','running') LIMIT 1`,
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
    this.blobs?.applyRefDelta([], attachmentIds);
    this.audit("operator", "run.create", id, { machineId, workspaceRoot, via: opts.via ?? "new", status });
    if (status === "dispatched") {
      this.registry.sendTo(machineId, win.windowId, this.startMessage({ id, workspace_root: workspaceRoot, prompt, attachments: attachmentsJson }, now));
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
      if (!["dispatched", "binding"].includes(r.status) && !this.isFalseBindTimeout(r) && !this.isFalseDispatchTimeout(r)) return false;
      return this.promptCompatible(r, prompt);
    });
    return hits.length === 1 ? hits[0] : null;
  }

  onRunAck(machineId: string, msg: any) {
    const run = this.get(msg.runId);
    if (!run) return;
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
      this.setStatus(run.id, "error", { end_reason: msg.reason ?? "REJECTED" }, "extension");
      this.promoteNextQueued(machineId);
    }
  }

  onRunBound(machineId: string, msg: any) {
    const run = this.get(msg.runId);
    if (!run) return;
    const recoverable = this.isFalseDispatchTimeout(run) || this.isFalseBindTimeout(run);
    if (!["binding", "dispatched"].includes(run.status) && !recoverable) return;
    if (recoverable && this.denyReviveIfSlotBusy(machineId, run.id)) return;
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
    if (!["dispatched", "binding"].includes(run.status)) return;
    this.setStatus(run.id, "unknown", { end_reason: "BIND_AMBIGUOUS" }, "extension");
    this.promoteNextQueued(run.machine_id);
  }

  /** Prefer the stored window if still online; else the live workspace window (Cursor reload changes windowId). */
  private liveWindowId(run: { machine_id: string; window_id: string | null; workspace_root: string }): string | null {
    if (run.window_id && this.registry.isConnected(run.machine_id, run.window_id)) return run.window_id;
    return this.registry.findWindowForWorkspace(run.machine_id, run.workspace_root)?.windowId ?? null;
  }

  onCancelRequested(runId: string): { error?: string } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    if (run.status === "queued") {
      this.setStatus(runId, "cancelled", { end_reason: "cancelled" }, "operator");
      this.promoteNextQueued(run.machine_id);
      return {};
    }
    if (!ACTIVE.includes(run.status)) return { error: "ALREADY_TERMINAL" };
    this.cancelRequested.add(runId);
    const windowId = this.liveWindowId(run);
    let sent = false;
    if (run.conversation_id && windowId) {
      if (windowId !== run.window_id) {
        this.db.query("UPDATE runs SET window_id=?1 WHERE id=?2").run(windowId, runId);
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

  onStopEvent(runId: string, payload: any) {
    const run = this.get(runId);
    if (!run) return;
    // BIND_TIMEOUT / DISPATCH_TIMEOUT 误杀后真实事件仍可能到达
    const recoverable = this.isFalseBindTimeout(run) || this.isFalseDispatchTimeout(run);
    if (!ACTIVE.includes(run.status) && !recoverable) return;
    if (this.shouldIgnoreStaleFollowupStop(run)) return;
    const s = payload?.status;
    if (s === "completed") this.setStatus(runId, "completed", { end_reason: "completed" }, "extension");
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
    }
    this.cancelRequested.delete(runId);
    this.promoteNextQueued(run.machine_id);
  }

  /**
   * Windows followup re-tails the jsonl from offset 0 (new window / reload).
   * Historical turn_ended is synthesized as stop/completed before the new
   * user prompt exists. Ignore that until a non-hub user event matches the
   * followup prompt. Bound/ack resets started_at, so key off the hub
   * followup event seq, not started_at.
   */
  private latestHubFollowup(runId: string): { seq: number; prompt: string } | null {
    const row = this.db.query(
      `SELECT seq, payload FROM run_events
       WHERE run_id=?1 AND source='hub' AND hook_event_name='beforeSubmitPrompt'
       ORDER BY seq DESC LIMIT 1`,
    ).get(runId) as { seq: number; payload: string } | null;
    if (!row) return null;
    try {
      const prompt = (JSON.parse(row.payload) as { prompt?: unknown }).prompt;
      if (typeof prompt !== "string" || !prompt.trim()) return null;
      return { seq: row.seq, prompt: normalizePrompt(prompt) };
    } catch {
      return null;
    }
  }

  private hasMatchingLiveUser(runId: string, want: string, afterSeq: number): boolean {
    const rows = this.db.query(
      `SELECT payload FROM run_events WHERE run_id=?1 AND seq>?2 AND source!='hub'`,
    ).all(runId, afterSeq) as { payload: string }[];
    for (const row of rows) {
      let payload: unknown = row.payload;
      try { payload = JSON.parse(row.payload); } catch { /* keep raw */ }
      const got = userPromptFromEventPayload(payload);
      if (got && normalizePrompt(got) === want) return true;
    }
    return false;
  }

  private shouldIgnoreStaleFollowupStop(run: { id: string }): boolean {
    const followup = this.latestHubFollowup(run.id);
    if (!followup) return false;
    return !this.hasMatchingLiveUser(run.id, followup.prompt, followup.seq);
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
    for (const r of b) if (age(r) > BIND_TIMEOUT_MS) {
      this.setStatus(r.id, "unknown", { end_reason: "BIND_TIMEOUT" });
      machines.add(r.machine_id);
    }
    for (const machineId of machines) this.promoteNextQueued(machineId);
  }

  onMachineOffline(machineId: string) {
    const rows = this.db.query(
      `SELECT id, status FROM runs WHERE machine_id=?1 AND status IN ('queued','dispatched','binding','running')`
    ).all(machineId) as any[];
    for (const r of rows) {
      if (r.status === "queued") this.setStatus(r.id, "cancelled", { end_reason: "MACHINE_OFFLINE" });
      else this.setStatus(r.id, "unknown", { end_reason: "MACHINE_OFFLINE" });
    }
    this.promoteNextQueued(machineId);
  }

  list(status?: string, machineId?: string, archived?: string) {
    let sql = "SELECT * FROM runs WHERE 1=1"; const args: string[] = [];
    if (status) { sql += " AND status=?"; args.push(status); }
    if (machineId) { sql += " AND machine_id=?"; args.push(machineId); }
    if (archived === "1") sql += " AND archived_at IS NOT NULL";
    else if (archived !== "all") sql += " AND archived_at IS NULL";
    return this.db.query(sql + " ORDER BY created_at DESC").all(...args);
  }

  get(id: string): any {
    return this.db.query("SELECT * FROM runs WHERE id=?1").get(id) ?? null;
  }

  getByConversation(cid: string): any {
    return this.db.query("SELECT * FROM runs WHERE conversation_id=?1 ORDER BY created_at DESC LIMIT 1").get(cid) ?? null;
  }

  getActiveByConversation(cid: string): any {
    return this.db.query(
      `SELECT * FROM runs WHERE conversation_id=?1 AND status IN ('created','dispatched','binding','running')
       ORDER BY created_at DESC LIMIT 1`,
    ).get(cid) ?? null;
  }

  /** 同工作区其它卡片仍占用时，续聊会抢回旧对话；新任务应走 +派发 → newAgentChat。 */
  private workspaceOccupiedByOther(machineId: string, workspaceRoot: string, exceptRunId: string): boolean {
    const row = this.db.query(
      `SELECT id FROM runs WHERE machine_id=?1 AND workspace_root=?2 AND id!=?3 AND status IN ('queued','dispatched','binding','running') LIMIT 1`,
    ).get(machineId, workspaceRoot, exceptRunId);
    return !!row;
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
   * 本卡仍占用中 → CONVERSATION_BUSY；同工作区其它卡占用 → WINDOW_BUSY；注入槽被占 → INJECT_SLOT_BUSY。
   */
  followup(runId: string, prompt: string, attachmentIds: string[] = []): { error?: string; run?: any } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    if (!run.conversation_id) return { error: "NO_CONVERSATION" };
    if (run.end_reason === "OPERATOR_CLOSED") return { error: "CLOSED" };
    if ((OCCUPYING_STATUSES as readonly string[]).includes(run.status)) return { error: "CONVERSATION_BUSY" };
    if (this.injectSlotCount(run.machine_id) > 0) return { error: "INJECT_SLOT_BUSY" };
    if (this.workspaceOccupiedByOther(run.machine_id, run.workspace_root, runId)) return { error: "WINDOW_BUSY" };
    const win = this.registry.findWindowForWorkspace(run.machine_id, run.workspace_root);
    if (!win) return { error: "WORKSPACE_NOT_OPEN" };

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

    this.blobs?.applyRefDelta([], attachmentIds);
    this.db.query("UPDATE runs SET attachments=?1 WHERE id=?2").run(JSON.stringify(attachmentIds), runId);

    this.setStatus(runId, "dispatched", {
      ended_at: null, end_reason: null, started_at: Date.now(), window_id: win.windowId,
    });
    if (attachmentIds.length === 0) this.recordFollowupPrompt(run, prompt);
    else this.pendingFollowupPrompt.set(runId, { prompt, attachmentIds });

    const attachments = this.wsAttachments(attachmentIds);
    this.registry.sendTo(run.machine_id, win.windowId, {
      type: "run.followup", runId, conversationId: run.conversation_id, workspaceRoot: run.workspace_root, prompt,
      ...(attachments && attachments.length ? { attachments } : {}),
    });
    this.audit("hub", "run.followup", runId, { prompt: prompt.slice(0, 80) });
    return { run: this.get(runId) };
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
