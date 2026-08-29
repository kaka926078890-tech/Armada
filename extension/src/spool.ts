import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, statSync, rmdirSync } from "fs";
import { join } from "path";

export interface OutboundEvent {
  seq: number;
  hook: string;
  ts: number;
  raw: Record<string, unknown>;
}

const UNPARSED_MAX = 4000;
const SEQ_LOCK_STALE_MS = 10_000;

function parseSpoolFile(path: string): Pick<OutboundEvent, "hook" | "ts" | "raw"> {
  const body = readFileSync(path, "utf8");
  try {
    const j = JSON.parse(body);
    return {
      hook: typeof j.__hook === "string" ? j.__hook : "unknown",
      ts: typeof j.__ts === "number" ? j.__ts : 0,
      raw: j.__raw ?? {},
    };
  } catch {
    return { hook: "unknown", ts: 0, raw: { __unparsed: body.slice(0, UNPARSED_MAX) } };
  }
}

export class SpoolForwarder {
  private seqFile: string;
  private lockDir: string;
  constructor(private opts: {
    spoolDir: string;
    stateDir: string;
    send: (ev: OutboundEvent) => void;
  }) {
    mkdirSync(opts.spoolDir, { recursive: true });
    mkdirSync(opts.stateDir, { recursive: true });
    this.seqFile = join(opts.stateDir, "seq");
    this.lockDir = join(opts.spoolDir, ".seq.lock");
  }

  /** Max `^(\d+)-` prefix among files in spoolDir (0 if none). */
  private maxSpoolSeq(): number {
    let max = 0;
    for (const f of readdirSync(this.opts.spoolDir)) {
      const m = /^(\d+)-/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  /**
   * Persisted counter. Missing file → 0 (fresh).
   * Present but empty/NaN → recover from spool max prefix (crash-truncation).
   * Note: Number("") === 0 — empty must be treated as corrupt, not fresh zero.
   */
  private currentSeq(): number {
    if (!existsSync(this.seqFile)) return 0;
    const text = readFileSync(this.seqFile, "utf8").trim();
    if (text === "") return this.maxSpoolSeq();
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return this.maxSpoolSeq();
    return n;
  }

  private persistSeq(n: number): void {
    const tmp = this.seqFile + ".tmp";
    writeFileSync(tmp, String(n));
    renameSync(tmp, this.seqFile);
  }

  private nextSeq(): number {
    const next = this.currentSeq() + 1;
    this.persistSeq(next);
    return next;
  }

  /**
   * Machine-level mutex for seq allocation (mkdir is atomic).
   * Stale lock (>10s) is treated as deadlock and force-taken.
   * Returns false if another window holds a fresh lock — caller skips this poll round.
   */
  private tryAcquireSeqLock(): boolean {
    try {
      mkdirSync(this.lockDir);
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        const age = Date.now() - statSync(this.lockDir).mtimeMs;
        if (age <= SEQ_LOCK_STALE_MS) return false;
        try { rmdirSync(this.lockDir); } catch { /* peer won race */ }
        try {
          mkdirSync(this.lockDir);
          return true;
        } catch {
          return false;
        }
      } catch {
        return false;
      }
    }
  }

  private releaseSeqLock(): void {
    try { rmdirSync(this.lockDir); } catch { /* already gone */ }
  }

  /** Assigned iff name matches `^\d+-` and prefix ≤ persisted seq (avoids treating fixture names like `100-a.json` as assigned). */
  private assigned(file: string): number | null {
    const m = /^(\d+)-/.exec(file);
    if (!m) return null;
    const seq = Number(m[1]);
    if (seq > this.currentSeq()) return null;
    return seq;
  }

  poll(): number {
    const files = readdirSync(this.opts.spoolDir)
      .filter((f) => f.endsWith(".json") && this.assigned(f) === null)
      .map((f) => ({ f, mtime: statSync(join(this.opts.spoolDir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    if (files.length === 0) return 0;
    if (!this.tryAcquireSeqLock()) return 0;
    let n = 0;
    try {
      for (const { f } of files) {
        const p = join(this.opts.spoolDir, f);
        if (!existsSync(p) || this.assigned(f) !== null) continue;
        const seq = this.nextSeq();
        let parsed: Pick<OutboundEvent, "hook" | "ts" | "raw">;
        try {
          parsed = parseSpoolFile(p);
        } catch (e: any) {
          if (e?.code === "ENOENT") continue;
          throw e;
        }
        const ev: OutboundEvent = { seq, ...parsed };
        try {
          renameSync(p, join(this.opts.spoolDir, `${seq}-${f}`));
        } catch (e: any) {
          // Another window already renamed this file — skip, leave seq gap (hub tolerates gaps; duplicates are fatal).
          if (e?.code === "ENOENT") continue;
          throw e;
        }
        this.opts.send(ev);
        n += 1;
      }
    } finally {
      this.releaseSeqLock();
    }
    return n;
  }

  ack(lastSeq: number): number {
    let n = 0;
    for (const f of readdirSync(this.opts.spoolDir)) {
      const seq = this.assigned(f);
      if (seq !== null && seq <= lastSeq) {
        try { unlinkSync(join(this.opts.spoolDir, f)); n += 1; } catch { /* gone */ }
      }
    }
    return n;
  }

  resendUnacked(): number {
    const files = readdirSync(this.opts.spoolDir)
      .map((f) => ({ f, seq: this.assigned(f) }))
      .filter((x): x is { f: string; seq: number } => x.seq !== null)
      .sort((a, b) => a.seq - b.seq);
    for (const { f, seq } of files) {
      const parsed = parseSpoolFile(join(this.opts.spoolDir, f));
      this.opts.send({ seq, ...parsed });
    }
    return files.length;
  }
}
