/** Local Cursor vsix reload is operator-gated; the extension executes Reload Window. */

export const IDLE_RELOAD_MAX_WAIT_MS = 15 * 60 * 1000;
/** when-idle: do not Reload the window that just synthesized stop / wrote turn_ended. */
export const IDLE_RELOAD_SETTLE_GRACE_MS = 2 * 60 * 1000;
export const PENDING_RELOAD_NAME = "pending-reload.json";
export const PENDING_RELOAD_ATTEMPT_NAME = "pending-reload-attempt.json";

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

export function parseReloadAttempt(raw: unknown): { setAt: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const setAt = (raw as { setAt?: unknown }).setAt;
  if (typeof setAt !== "number" || !Number.isFinite(setAt) || setAt <= 0) return null;
  return { setAt };
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
 * Per-machine Reload chrome. A machine that already runs pending.vsix (or the
 * required vsix when nothing is pending) must not keep showing the buttons.
 */
export function vsixFileName(version: string): string {
  const v = version.trim();
  return v ? `armada-agent-${v}.vsix` : "";
}

export function vsixPackMissingNotice(version: string): string {
  const name = vsixFileName(version) || "armada-agent.vsix";
  return `扩展包 ${name} 还没有，需要先打包。只点 Reload 不会装上新扩展。`;
}

/** Reload target is the newer of leftover pending and the hub pin. */
export function reloadTargetVsix(pending: PendingReload | null, requiredVsix: string): string {
  const req = requiredVsix.trim();
  const p = pending?.vsix?.trim() ?? "";
  if (!p) return req;
  if (!req) return p;
  return cmpSemver(p, req) >= 0 ? p : req;
}

export function neededReloadMachineIds(
  pending: PendingReload | null,
  machines: ReloadMachine[],
  requiredVsix: string,
): string[] {
  const target = reloadTargetVsix(pending, requiredVsix);
  if (!target) return [];
  const online = machines.filter((m) => m.status === "online");
  const pendingStale = !!(pending?.vsix && requiredVsix.trim() && cmpSemver(pending.vsix, requiredVsix.trim()) < 0);
  const scoped = pending?.machineId && !pendingStale ? online.filter((m) => m.id === pending.machineId) : online;
  const probe: PendingReload = {
    action: pending?.action ?? "when-idle",
    vsix: target,
    setAt: pending?.setAt ?? 1,
    notBefore: pending?.notBefore ?? 1,
  };
  return scoped.filter((m) => reloadStillNeeded(probe, [m.extension_version])).map((m) => m.id);
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

function lastLineIsSettledTurn(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  try {
    const j = JSON.parse(t) as { type?: unknown };
    return j.type === "turn_ended";
  } catch {
    return false;
  }
}

/**
 * Local Cursor composers that are not Armada-bound still trip Reload Window's
 * "N agents are still working" dialog. Idle signal is the same jsonl
 * `turn_ended` used for synth stop. Stale mid-turn files (no write within
 * maxStaleMs) are abandoned, not busy.
 */
export function windowHasOpenComposerTurn(opts: {
  files: Array<{ lastLine: string; mtimeMs: number }>;
  now: number;
  maxStaleMs?: number;
}): boolean {
  const max = opts.maxStaleMs ?? IDLE_RELOAD_MAX_WAIT_MS;
  for (const f of opts.files) {
    if (typeof f.mtimeMs !== "number" || !Number.isFinite(f.mtimeMs)) continue;
    if (opts.now - f.mtimeMs > max) continue;
    const line = typeof f.lastLine === "string" ? f.lastLine.trim() : "";
    if (!line) continue;
    if (!lastLineIsSettledTurn(line)) return true;
  }
  return false;
}

/**
 * A just-written `turn_ended` or a just-synthesized Armada stop is not idle
 * for `when-idle`. 18:18:12 stop → 18:18:18 Reload yanked the operator chat.
 */
export function windowHasRecentSettle(opts: {
  files: Array<{ lastLine: string; mtimeMs: number }>;
  lastStopAt?: number | null;
  now: number;
  graceMs?: number;
}): boolean {
  const grace = opts.graceMs ?? IDLE_RELOAD_SETTLE_GRACE_MS;
  if (typeof opts.lastStopAt === "number" && Number.isFinite(opts.lastStopAt) && opts.lastStopAt > 0) {
    if (opts.now - opts.lastStopAt >= 0 && opts.now - opts.lastStopAt < grace) return true;
  }
  for (const f of opts.files) {
    if (typeof f.mtimeMs !== "number" || !Number.isFinite(f.mtimeMs)) continue;
    const line = typeof f.lastLine === "string" ? f.lastLine : "";
    if (!lastLineIsSettledTurn(line)) continue;
    if (opts.now - f.mtimeMs >= 0 && opts.now - f.mtimeMs < grace) return true;
  }
  return false;
}

/**
 * Per Cursor window: `when-idle` never Reloads while this window has an
 * in-flight Armada run (pending start or bound run without synthesized stop).
 * Completed binds may stay in `boundRuns` for followup and are not live.
 * Both `when-idle` and `now` wait for a fresh open composer jsonl turn so
 * Reload Window does not stack the agents-still-working dialog.
 * `when-idle` also waits `IDLE_RELOAD_SETTLE_GRACE_MS` after stop / turn_ended.
 * `now` still Reloads through an Armada live run that has no open jsonl turn
 * (pending start / inject), including a just-settled window.
 * `expired` = waited maxWaitMs still busy → notify, do not force.
 * `done` = this window already runs pending.vsix or newer.
 * `missing` = pending vsix is not on disk; Reload Window cannot install it.
 */
export type WindowReloadDecision = "none" | "wait" | "reload" | "expired" | "done" | "missing";

export function highestInstalledArmadaAgent(dirNames: Iterable<string>): string | null {
  let best: string | null = null;
  for (const name of dirNames) {
    const m = /^armada\.armada-agent-(\d+\.\d+\.\d+)/.exec(name);
    if (!m) continue;
    if (!best || cmpSemver(m[1], best) > 0) best = m[1];
  }
  return best;
}

export function decideWindowReload(opts: {
  pending: PendingReload | null;
  thisWindowHasLiveRun: boolean;
  thisWindowHasOpenComposerTurn?: boolean;
  thisWindowRecentlySettled?: boolean;
  now: number;
  runningVsix?: string;
  /** When set (including `null`), Reload is refused if disk is still behind pending.vsix. */
  installedVsix?: string | null;
  maxWaitMs?: number;
  machineId?: string;
}): WindowReloadDecision {
  const p = opts.pending;
  if (!p) return "none";
  if (p.machineId && opts.machineId && p.machineId !== opts.machineId) return "none";
  if (opts.runningVsix && cmpSemver(opts.runningVsix, p.vsix) >= 0) return "done";
  if (opts.installedVsix !== undefined) {
    if (!opts.installedVsix || cmpSemver(opts.installedVsix, p.vsix) < 0) return "missing";
  }
  if (opts.now < p.notBefore) return "wait";
  const composerBusy = opts.thisWindowHasOpenComposerTurn === true;
  const recentlySettled = opts.thisWindowRecentlySettled === true;
  const armadaBusy = opts.thisWindowHasLiveRun;
  const busy = composerBusy || (p.action !== "now" && (armadaBusy || recentlySettled));
  if (busy) {
    const max = opts.maxWaitMs ?? IDLE_RELOAD_MAX_WAIT_MS;
    if (opts.now - p.setAt >= max) return "expired";
    return "wait";
  }
  return "reload";
}

/**
 * Cursor's Reload Window confirmation stays up if a local composer (AskQuestion
 * etc.) is still working. `decideWindowReload` waits for Armada live runs and
 * fresh open jsonl turns; the 10s poll would still restack that dialog if we
 * re-fired after a confirmation that left the window alive.
 * Fire at most once per pending until the command settles; retry only after a
 * busy→idle edge (Armada run started then finished) or a new pending setAt.
 * `attemptedSetAt` is the on-disk latch for a pending that already survived a
 * real window reload (in-memory state is gone; repeating Reload cannot install
 * a missing vsix).
 */
export type ReloadFireState = {
  lastFiredSetAt: number | null;
  lastDecision: WindowReloadDecision | null;
  inFlight: boolean;
};

export function decideReloadFire(
  state: ReloadFireState,
  opts: { decision: WindowReloadDecision; pendingSetAt: number | null; attemptedSetAt?: number | null },
): { fire: boolean; next: ReloadFireState } {
  const lastDecision = opts.decision;
  if (opts.decision !== "reload" || opts.pendingSetAt == null) {
    return { fire: false, next: { ...state, lastDecision } };
  }
  // Survived a real Reload Window: in-memory latch is gone, but retrying the
  // same pending cannot install a missing vsix — it only restacks reloads.
  if (opts.attemptedSetAt === opts.pendingSetAt) {
    return { fire: false, next: { ...state, lastFiredSetAt: opts.pendingSetAt, lastDecision } };
  }
  if (state.inFlight) {
    return { fire: false, next: { ...state, lastDecision } };
  }
  const idleEdge = state.lastDecision === "wait";
  if (state.lastFiredSetAt === opts.pendingSetAt && !idleEdge) {
    return { fire: false, next: { ...state, lastDecision } };
  }
  return {
    fire: true,
    next: { lastFiredSetAt: opts.pendingSetAt, lastDecision, inFlight: true },
  };
}

export function noteReloadCommandSettled(state: ReloadFireState): ReloadFireState {
  return { ...state, inFlight: false };
}
