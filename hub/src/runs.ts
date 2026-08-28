import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { Registry } from "./registry";

const ACTIVE = ["created", "dispatched", "binding", "running"];
const DISPATCH_TIMEOUT_MS = 5_000;
const BIND_TIMEOUT_MS = 60_000;

export class RunService {
  private cancelRequested = new Set<string>();
  constructor(private db: Database, private registry: Registry) {
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
        type: "run.followup", runId: id, conversationId: opts.conversationId, prompt,
      });
      this.audit("hub", "run.followup", id);
    } else {
      this.registry.sendTo(machineId, win.windowId, { type: "run.start", runId: id, workspaceRoot, prompt });
      this.audit("hub", "run.dispatched", id);
    }
    return { run: this.get(id) };
  }

  onRunAck(_machineId: string, msg: any) {
    const run = this.get(msg.runId);
    if (!run || run.status !== "dispatched") return;
    if (msg.status === "accepted") this.setStatus(run.id, "binding", {}, "extension");
    else this.setStatus(run.id, "error", { end_reason: msg.reason ?? "REJECTED" }, "extension");
  }

  onRunBound(_machineId: string, msg: any) {
    const run = this.get(msg.runId);
    if (!run || !["binding", "dispatched"].includes(run.status)) return;
    this.setStatus(run.id, "running", {
      conversation_id: msg.conversationId ?? null,
      transcript_path: msg.transcriptPath ?? null,
      started_at: Date.now(),
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
    if (!run || !ACTIVE.includes(run.status)) return;
    const s = payload?.status;
    if (s === "completed") this.setStatus(runId, "completed", { end_reason: "completed" }, "extension");
    else if (s === "aborted") {
      const wasCancel = this.cancelRequested.has(runId);
      this.setStatus(runId, wasCancel ? "cancelled" : "aborted", { end_reason: wasCancel ? "cancelled" : "aborted" }, "extension");
    } else if (s === "error") this.setStatus(runId, "error", { end_reason: payload?.error ?? "error" }, "extension");
    this.cancelRequested.delete(runId);
  }

  sweepTimeouts(now = Date.now()) {
    const d = this.db.query("SELECT id, created_at FROM runs WHERE status='dispatched'").all() as any[];
    for (const r of d) if (now - r.created_at > DISPATCH_TIMEOUT_MS) this.setStatus(r.id, "error", { end_reason: "DISPATCH_TIMEOUT" });
    const b = this.db.query("SELECT id, created_at FROM runs WHERE status='binding'").all() as any[];
    for (const r of b) if (now - r.created_at > BIND_TIMEOUT_MS) this.setStatus(r.id, "unknown", { end_reason: "BIND_TIMEOUT" });
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
}
