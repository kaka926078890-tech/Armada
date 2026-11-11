import { existsSync } from "fs";
import { homedir } from "os";
import {
  emptyCursor, matchComposerByCreatedAt, planComposerTick, readComposerView, readHeaderCandidates,
  type ComposerCursor, type DbEvent,
} from "../../hub/src/composerDb";
import { cursorStateDbPath } from "./askStore";
import type { PendingRun } from "./binding";

type Kv = {
  query(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
};

export function createWindowsComposerFeed(opts: {
  enabled: boolean;
  open: () => Promise<{ db: Kv; close: () => void } | null>;
  onBind: (run: PendingRun, conversationId: string) => void;
  onEvent: (runId: string, event: DbEvent) => void;
}) {
  const pending = new Map<string, PendingRun>();
  const cidByRun = new Map<string, string>();
  const cursors = new Map<string, ComposerCursor>();

  return {
    note(run: PendingRun) {
      if (!opts.enabled || run.anchorAt == null) return;
      pending.set(run.runId, run);
    },
    /** Reload already knows the composer. Keep polling that cid; do not reset a live cursor. */
    watch(runId: string, conversationId: string) {
      if (!opts.enabled || !conversationId) return;
      if (cidByRun.get(runId) === conversationId && cursors.has(runId)) return;
      cidByRun.set(runId, conversationId);
      cursors.set(runId, emptyCursor());
    },
    forget(runId: string) {
      pending.delete(runId);
      cidByRun.delete(runId);
      cursors.delete(runId);
    },
    async poll() {
      if (!opts.enabled || (pending.size === 0 && cidByRun.size === 0)) return;
      const opened = await opts.open();
      if (!opened) return;
      try {
        const bound = new Set(cidByRun.values());
        const waiting = [...pending.values()].filter((run) => !cidByRun.has(run.runId));
        if (waiting.length) {
          const since = Math.min(...waiting.map((run) => run.anchorAt ?? run.dispatchedAt)) - 1_000;
          const headers = readHeaderCandidates(opened.db, since);
          for (const run of waiting) {
            const cid = matchComposerByCreatedAt(headers, {
              workspaceRoot: run.workspaceRoot,
              createdAt: run.anchorAt ?? run.dispatchedAt,
            }, bound);
            if (!cid) continue;
            bound.add(cid);
            cidByRun.set(run.runId, cid);
            cursors.set(run.runId, emptyCursor());
            opts.onBind(run, cid);
          }
        }
        for (const [runId, cid] of cidByRun) {
          const view = readComposerView(opened.db, cid);
          if (!view) continue;
          const children = [];
          for (const id of view.subagentIds) {
            const child = readComposerView(opened.db, id);
            if (child) children.push(child);
          }
          const planned = planComposerTick(view, children, cursors.get(runId) ?? emptyCursor());
          cursors.set(runId, planned.cursor);
          for (const ev of planned.events) opts.onEvent(runId, ev);
        }
      } catch {
        /* locked or half-written cell: next poll retries */
      } finally {
        try { opened.close(); } catch { /* already closed */ }
      }
    },
  };
}

export async function openWindowsComposerDb(platform = process.platform, home = homedir()): Promise<{ db: Kv; close: () => void } | null> {
  const path = cursorStateDbPath(home, platform);
  if (!path || !existsSync(path)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(path, { readOnly: true });
    const db: Kv = {
      query(sql: string) {
        const stmt = sqlite.prepare(sql);
        return {
          all: (...args: unknown[]) => (stmt.all as (...a: unknown[]) => unknown[])(...args),
          get: (...args: unknown[]) => (stmt.get as (...a: unknown[]) => unknown)(...args),
        };
      },
    };
    return { db, close: () => sqlite.close() };
  } catch {
    return null;
  }
}
