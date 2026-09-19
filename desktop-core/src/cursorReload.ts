/** Local Cursor vsix reload is operator-gated; the extension executes Reload Window. */

export const IDLE_RELOAD_MAX_WAIT_MS = 15 * 60 * 1000;
export const PENDING_RELOAD_NAME = "pending-reload.json";

export type CursorReloadAction = "now" | "when-idle" | "skip";

export type PendingReload = {
  action: "now" | "when-idle";
  vsix: string;
  setAt: number;
  notBefore: number;
  /** Absent = every connected machine. */
  machineId?: string;
};

export function parsePendingReload(raw: unknown): PendingReload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.action !== "now" && o.action !== "when-idle") return null;
  if (typeof o.vsix !== "string" || !o.vsix.trim()) return null;
  if (typeof o.setAt !== "number" || !Number.isFinite(o.setAt) || o.setAt <= 0) return null;
  const notBefore = typeof o.notBefore === "number" && Number.isFinite(o.notBefore) ? o.notBefore : o.setAt;
  const machineId = typeof o.machineId === "string" && o.machineId.trim() ? o.machineId.trim() : undefined;
  return { action: o.action, vsix: o.vsix.trim(), setAt: o.setAt, notBefore, ...(machineId ? { machineId } : {}) };
}

export function pendingFromAction(
  action: CursorReloadAction,
  vsix: string,
  now: number,
  notBefore?: number,
  machineId?: string,
): PendingReload | null {
  if (action === "skip") return null;
  if (action !== "now" && action !== "when-idle") return null;
  const v = vsix.trim();
  if (!v) return null;
  if (!Number.isFinite(now) || now <= 0) return null;
  const start = notBefore != null && Number.isFinite(notBefore) ? notBefore : now;
  const mid = typeof machineId === "string" && machineId.trim() ? machineId.trim() : undefined;
  return { action, vsix: v, setAt: now, notBefore: start, ...(mid ? { machineId: mid } : {}) };
}

export function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x) || 0);
  const pb = b.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function reloadStillNeeded(
  pending: PendingReload | null,
  installed: Array<string | null | undefined>,
): boolean {
  if (!pending) return false;
  const live = installed.filter((v): v is string => typeof v === "string" && /^\d+\.\d+\.\d+/.test(v.trim()));
  if (live.length === 0) return true;
  return live.some((v) => cmpSemver(v.trim(), pending.vsix) < 0);
}

export type ReloadMachine = {
  id: string;
  status: string;
  extension_version?: string | null;
};

/** Banner: only online machines; a scoped pending only looks at that machine. */
export function reloadStillNeededForFleet(
  pending: PendingReload | null,
  machines: ReloadMachine[],
): boolean {
  if (!pending) return false;
  const online = machines.filter((m) => m.status === "online");
  const scoped = pending.machineId ? online.filter((m) => m.id === pending.machineId) : online;
  return reloadStillNeeded(pending, scoped.map((m) => m.extension_version));
}

/**
 * Busy for `when-idle` Reload: a pending start, or a bound run that has not
 * synthesized stop yet. Completed binds stay in `boundRuns` for followup and
 * must not count as live.
 */
export function windowHasInFlightArmadaRun(opts: {
  pendingStartCount: number;
  boundRunIds: Iterable<string>;
  stopSentRunIds: Iterable<string>;
}): boolean {
  if (opts.pendingStartCount > 0) return true;
  const done = new Set(opts.stopSentRunIds);
  for (const id of opts.boundRunIds) {
    if (!done.has(id)) return true;
  }
  return false;
}

/**
 * Per Cursor window: `when-idle` never Reloads while this window has an
 * in-flight Armada run (pending start or bound run without synthesized stop).
 * Completed binds may stay in `boundRuns` for followup and are not live.
 * `now` is operator-forced and Reloads even with a live run.
 * `expired` = waited maxWaitMs still busy → notify, do not force.
 * `done` = this window already runs pending.vsix or newer.
 */
export function decideWindowReload(opts: {
  pending: PendingReload | null;
  thisWindowHasLiveRun: boolean;
  now: number;
  runningVsix?: string;
  maxWaitMs?: number;
  machineId?: string;
}): "none" | "wait" | "reload" | "expired" | "done" {
  const p = opts.pending;
  if (!p) return "none";
  if (p.machineId && opts.machineId && p.machineId !== opts.machineId) return "none";
  if (opts.runningVsix && cmpSemver(opts.runningVsix, p.vsix) >= 0) return "done";
  if (opts.now < p.notBefore) return "wait";
  if (p.action === "now") return "reload";
  if (opts.thisWindowHasLiveRun) {
    const max = opts.maxWaitMs ?? IDLE_RELOAD_MAX_WAIT_MS;
    if (opts.now - p.setAt >= max) return "expired";
    return "wait";
  }
  return "reload";
}
