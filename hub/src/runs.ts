import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { Registry } from "./registry";
import type { SseHub } from "./sse";

const ACTIVE = ["created", "dispatched", "binding", "running"];
const DISPATCH_TIMEOUT_MS = 30_000;
const BIND_TIMEOUT_MS = 60_000;

export class RunService {
  private cancelRequested = new Set<string>();
  constructor(private db: Database, private registry: Registry, private sse: SseHub) {
    registry.onMachineOffline = (id) => this.onMachineOffline(id);
  }

  private audit(actor: string, action: string, target: string, payload?: object) {
    this.db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,?2,?3,?4,?5)")
      .run(Date.now(), actor, action, target, payload ? JSON.stringify(payload) : null);
  }

  private setStatus(id: string, status: string, extra: Record<string, unknown> = {}, actor = "hub") {
    const sets = ["status=?2"]; const vals: unknown[] = [id, status];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?${vals.length + 1}`); vals.push(v); }
    if (["completed", "aborted", "error", "cancelled", "unknown"].includes(status) && !("ended_at" in extra)) {
      sets.push(`ended_at=?${vals.length + 1}`); vals.push(Date.now());
    }
    this.db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id=?1`).run(...vals as any);
    this.audit(actor, `run.${status}`, id, extra);
    this.sse.broadcast(id, { type: "run.status", runId: id, status });
  }

  create(machineId: string, workspaceRoot: string, prompt: string,
         opts: { parentRunId?: string; conversationId?: string; via?: "new" | "followup" } = {}) {
    const m = this.registry.getMachine(machineId);
    if (!m || m.status !== "online") return { error: "MACHINE_OFFLINE" };
    if (!JSON.parse(m.open_workspaces).includes(workspaceRoot)) return { error: "WORKSPACE_NOT_OPEN" };
    const busy = this.db.query(
      "SELECT id FROM runs WHERE machine_id=?1 AND status IN (?2,?3,?4,?5)"
    ).get(machineId, ...ACTIVE);
    if (busy) return { error: "RUN_BUSY" };
    const win = this.registry.findWindowForWorkspace(machineId, workspaceRoot);
    if (!win) return { error: "WORKSPACE_NOT_OPEN" };

    const id = `r-${randomUUID()}`;
    this.db.query(`INSERT INTO runs (id, machine_id, window_id, workspace_root, prompt, status, conversation_id, parent_run_id, created_at)
                   VALUES (?1,?2,?3,?4,?5,'dispatched',?6,?7,?8)`)
      .run(id, machineId, win.windowId, workspaceRoot, prompt, opts.conversationId ?? null, opts.parentRunId ?? null, Date.now());
    this.audit("operator", "run.create", id, { machineId, workspaceRoot, via: opts.via ?? "new" });
    if (opts.via === "followup") {
      this.registry.sendTo(machineId, win.windowId, {
        type: "run.followup", runId: id, conversationId: opts.conversationId, workspaceRoot, prompt,
      });
      this.audit("hub", "run.followup", id);
    } else {
      this.registry.sendTo(machineId, win.windowId, { type: "run.start", runId: id, workspaceRoot, prompt, dispatchedAt: Date.now() });
      this.audit("hub", "run.dispatched", id);
    }
    return { run: this.get(id) };
  }

  /** 派发其实成功、ack 在 WS 抖动里迟到:允许从 DISPATCH_TIMEOUT 误杀收回。 */
  private isFalseDispatchTimeout(run: { status: string; end_reason: string | null }): boolean {
    return run.status === "error" && run.end_reason === "DISPATCH_TIMEOUT";
  }

  onRunAck(_machineId: string, msg: any) {
    const run = this.get(msg.runId);
    if (!run) return;
    const recoverable = this.isFalseDispatchTimeout(run);
    if (run.status !== "dispatched" && !recoverable) return;
    if (msg.status === "accepted") {
      this.setStatus(run.id, "binding", recoverable
        ? { ended_at: null, end_reason: null, started_at: Date.now() }
        : {}, "extension");
    } else if (!recoverable) {
      this.setStatus(run.id, "error", { end_reason: msg.reason ?? "REJECTED" }, "extension");
    }
  }

  onRunBound(_machineId: string, msg: any) {
    const run = this.get(msg.runId);
    if (!run) return;
    const recoverable = this.isFalseDispatchTimeout(run);
    if (!["binding", "dispatched"].includes(run.status) && !recoverable) return;
    this.setStatus(run.id, "running", {
      conversation_id: msg.conversationId ?? null,
      transcript_path: msg.transcriptPath ?? null,
      started_at: Date.now(),
      ...(recoverable ? { ended_at: null, end_reason: null } : {}),
    }, "extension");
  }

  onCancelRequested(runId: string): { error?: string } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    if (!ACTIVE.includes(run.status)) return { error: "ALREADY_TERMINAL" };
    this.cancelRequested.add(runId);
    if (run.conversation_id && run.window_id) {
      this.registry.sendTo(run.machine_id, run.window_id, { type: "run.cancel", runId, conversationId: run.conversation_id });
    }
    this.audit("operator", "run.cancel.requested", runId);
    return {};
  }

  onStopEvent(runId: string, payload: any) {
    const run = this.get(runId);
    if (!run) return;
    // BIND_TIMEOUT / DISPATCH_TIMEOUT 误杀后真实事件仍可能到达
    const recoverable = (run.status === "unknown" && run.end_reason === "BIND_TIMEOUT")
      || this.isFalseDispatchTimeout(run);
    if (!ACTIVE.includes(run.status) && !recoverable) return;
    const s = payload?.status;
    if (s === "completed") this.setStatus(runId, "completed", { end_reason: "completed" }, "extension");
    else if (s === "aborted") {
      const wasCancel = this.cancelRequested.has(runId);
      this.setStatus(runId, wasCancel ? "cancelled" : "aborted", { end_reason: wasCancel ? "cancelled" : "aborted" }, "extension");
    } else if (s === "error") this.setStatus(runId, "error", { end_reason: payload?.error ?? "error" }, "extension");
    this.cancelRequested.delete(runId);
  }

  sweepTimeouts(now = Date.now()) {
    // 超时锚点 = 最近一次派发时刻:续聊会把 started_at 重置。
    // 若用 created_at,老卡片 followup 后会立刻 BIND_TIMEOUT(真机:created 8:41,续聊 9:05,1s 后进未知)。
    const age = (r: { created_at: number; started_at: number | null }) => now - (r.started_at ?? r.created_at);
    const d = this.db.query("SELECT id, created_at, started_at FROM runs WHERE status='dispatched'").all() as any[];
    for (const r of d) if (age(r) > DISPATCH_TIMEOUT_MS) this.setStatus(r.id, "error", { end_reason: "DISPATCH_TIMEOUT" });
    const b = this.db.query("SELECT id, created_at, started_at FROM runs WHERE status='binding'").all() as any[];
    for (const r of b) if (age(r) > BIND_TIMEOUT_MS) this.setStatus(r.id, "unknown", { end_reason: "BIND_TIMEOUT" });
  }

  onMachineOffline(machineId: string) {
    const rows = this.db.query(
      `SELECT id FROM runs WHERE machine_id=?1 AND status IN ('dispatched','binding','running')`
    ).all(machineId) as any[];
    for (const r of rows) this.setStatus(r.id, "unknown", { end_reason: "MACHINE_OFFLINE" });
  }

  list(status?: string, machineId?: string) {
    let sql = "SELECT * FROM runs WHERE 1=1"; const args: string[] = [];
    if (status) { sql += " AND status=?"; args.push(status); }
    if (machineId) { sql += " AND machine_id=?"; args.push(machineId); }
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

  /**
   * 续聊:同一张卡片回到 dispatched,事件继续追加。不新建 child run。
   * 其它机器上的活跃任务仍受 RUN_BUSY 约束(不含本 run)。
   */
  followup(runId: string, prompt: string): { error?: string; run?: any } {
    const run = this.get(runId);
    if (!run) return { error: "NOT_FOUND" };
    if (!run.conversation_id) return { error: "NO_CONVERSATION" };
    if (run.end_reason === "OPERATOR_CLOSED") return { error: "CLOSED" };
    if (ACTIVE.includes(run.status)) return { error: "ALREADY_ACTIVE" };
    const busy = this.db.query(
      "SELECT id FROM runs WHERE machine_id=?1 AND id!=?2 AND status IN (?3,?4,?5,?6)",
    ).get(run.machine_id, run.id, ...ACTIVE);
    if (busy) return { error: "RUN_BUSY" };
    const win = this.registry.findWindowForWorkspace(run.machine_id, run.workspace_root);
    if (!win) return { error: "WORKSPACE_NOT_OPEN" };

    this.setStatus(runId, "dispatched", { ended_at: null, end_reason: null, started_at: Date.now() });
    this.registry.sendTo(run.machine_id, win.windowId, {
      type: "run.followup", runId, conversationId: run.conversation_id, workspaceRoot: run.workspace_root, prompt,
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
}
