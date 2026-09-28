import type { Database } from "bun:sqlite";

/** 终态任务的事件和审计只留一周。进行中的任务不删。 */
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL = "'completed','error','aborted','cancelled'";

export function pruneHubLogs(
  db: Database,
  now = Date.now(),
  retentionMs = LOG_RETENTION_MS,
): { events: number; audit: number } {
  const cutoff = now - retentionMs;
  const events = db.query(
    `DELETE FROM run_events
     WHERE run_id IN (
       SELECT id FROM runs
       WHERE status IN (${TERMINAL})
         AND COALESCE(ended_at, created_at) < ?1
     )`,
  ).run(cutoff).changes;
  const audit = db.query("DELETE FROM audit WHERE ts < ?1").run(cutoff).changes;
  return { events, audit };
}
