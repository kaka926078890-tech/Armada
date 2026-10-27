import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir, hostname } from "os";
import { join } from "path";
import { parseAttachmentIds } from "./blobs";
import {
  cursorFromEmitted, matchComposer, pickLocalMachineId, planComposerTick,
  readComposerView, readHeaderCandidates, seedCursor, usesComposerDb,
  type ComposerCursor, type ComposerView,
} from "./composerDb";
import { ingestEvent } from "./ingest";
import type { Registry } from "./registry";
import type { RunService } from "./runs";
import type { SseHub } from "./sse";

function cursorDbPath(): string | null {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "win32") {
    return join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return null;
}

type RunLite = {
  id: string;
  workspace_root: string;
  prompt: string;
  status: string;
  conversation_id: string | null;
  created_at: number;
  attachments: string | null;
};

export function startComposerFeed(opts: {
  hub: Database;
  runs: RunService;
  sse: SseHub;
  registry: Registry;
  intervalMs?: number;
  cursorPath?: string | null;
}): { stop(): void } {
  const cursors = new Map<string, ComposerCursor>();
  let cursor: Database | null = null;
  let seq = Date.now() * 1000;
  const nextSeq = () => ++seq;

  const open = (): Database | null => {
    if (cursor) return cursor;
    const path = opts.cursorPath === undefined ? cursorDbPath() : opts.cursorPath;
    if (!path || !existsSync(path)) return null;
    try {
      cursor = new Database(path, { readonly: true });
      return cursor;
    } catch {
      return null;
    }
  };

  const tick = () => {
    try {
      tickBody();
    } catch (err) {
      console.error("composer-db tick", err);
      try { cursor?.close(); } catch { /* retry next tick */ }
      cursor = null;
    }
  };

  const tickBody = () => {
    const localId = pickLocalMachineId(
      opts.registry.listMachines(),
      hostname(),
      (id) => opts.registry.isMachineConnected(id),
    );
    if (!localId || !usesComposerDb(opts.hub, localId)) {
      cursors.clear();
      return;
    }
    const runs = opts.hub.query(
      `SELECT id, workspace_root, prompt, status, conversation_id, created_at, attachments
       FROM runs
       WHERE machine_id=?1 AND archived_at IS NULL AND status IN ('dispatched','binding','running')`,
    ).all(localId) as RunLite[];
    const active = new Set(runs.map((r) => r.id));
    for (const id of cursors.keys()) if (!active.has(id)) cursors.delete(id);
    if (!runs.length) return;
    const db = open();
    if (!db) return;

    const pending = runs.filter((r) => !r.conversation_id && (r.status === "dispatched" || r.status === "binding"));
    if (pending.length) {
      const since = Math.min(...pending.map((r) => r.created_at)) - 5_000;
      const headers = readHeaderCandidates(db, since);
      const bound = new Set(runs.map((r) => r.conversation_id).filter((x): x is string => !!x));
      for (const run of pending) {
        const cid = matchComposer(headers, {
          prompt: run.prompt,
          workspaceRoot: run.workspace_root,
          createdAt: run.created_at,
          attachmentCount: parseAttachmentIds(run.attachments).length,
        }, bound);
        if (!cid) continue;
        bound.add(cid);
        opts.runs.onRunBound(localId, { runId: run.id, conversationId: cid, promptMatch: true });
        console.log(`composer-db bind ${run.id} ${cid}`);
        run.conversation_id = cid;
        run.status = "running";
      }
    }

    for (const run of runs) {
      const cid = run.conversation_id;
      if (!cid) continue;
      const snap = readComposerView(db, cid);
      if (!snap) continue;
      const children: ComposerView[] = [];
      for (const id of snap.subagentIds) {
        const child = readComposerView(db, id);
        if (child) children.push(child);
      }
      let cur = cursors.get(run.id);
      if (!cur) {
        const dbEvents = opts.hub.query(
          `SELECT source, hook_event_name AS hook, payload FROM run_events
           WHERE run_id=?1 AND source IN ('db','subagent-transcript') ORDER BY seq`,
        ).all(run.id) as { source: string; hook: string | null; payload: string }[];
        if (dbEvents.length) {
          cur = cursorFromEmitted(dbEvents.map((e) => ({
            source: e.source,
            hook: e.hook,
            payload: JSON.parse(e.payload) as Record<string, unknown>,
          })));
        } else {
          const n = opts.hub.query("SELECT COUNT(*) AS n FROM run_events WHERE run_id=?1").get(run.id) as { n: number };
          cur = seedCursor(snap, children, n.n);
        }
      }
      const planned = planComposerTick(snap, children, cur);
      cursors.set(run.id, planned.cursor);
      for (const ev of planned.events) {
        if (ev.hook === "stop") console.log(`composer-db stop ${run.id} ${String(ev.payload.status)}`);
        ingestEvent(opts.hub, opts.runs, opts.sse, localId, {
          type: "run.event",
          runId: run.id,
          source: ev.source,
          hookEventName: ev.hook,
          conversationId: ev.conversationId,
          payload: ev.payload,
          ts: Date.now(),
          seq: nextSeq(),
        });
      }
    }
  };

  const timer = setInterval(tick, opts.intervalMs ?? 1000);
  return {
    stop() {
      clearInterval(timer);
      try { cursor?.close(); } catch { /* already closed */ }
      cursor = null;
    },
  };
}
