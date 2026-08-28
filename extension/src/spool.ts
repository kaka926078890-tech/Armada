import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";

export interface OutboundEvent {
  seq: number;
  hook: string;
  ts: number;
  raw: Record<string, unknown>;
}

export class SpoolForwarder {
  private seqFile: string;
  constructor(private opts: {
    spoolDir: string;
    stateDir: string;
    send: (ev: OutboundEvent) => void;
  }) {
    mkdirSync(opts.spoolDir, { recursive: true });
    mkdirSync(opts.stateDir, { recursive: true });
    this.seqFile = join(opts.stateDir, "seq");
  }

  private currentSeq(): number {
    return existsSync(this.seqFile) ? Number(readFileSync(this.seqFile, "utf8").trim()) || 0 : 0;
  }

  private nextSeq(): number {
    const next = this.currentSeq() + 1;
    writeFileSync(this.seqFile, String(next));
    return next;
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
    let n = 0;
    for (const { f } of files) {
      const seq = this.nextSeq();
      const p = join(this.opts.spoolDir, f);
      let ev: OutboundEvent;
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        ev = { seq, hook: typeof j.__hook === "string" ? j.__hook : "unknown", ts: typeof j.__ts === "number" ? j.__ts : 0, raw: j.__raw ?? {} };
      } catch {
        ev = { seq, hook: "unknown", ts: 0, raw: { __unparsed: readFileSync(p, "utf8").slice(0, 4000) } };
      }
      renameSync(p, join(this.opts.spoolDir, `${seq}-${f}`));
      this.opts.send(ev);
      n += 1;
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
      try {
        const j = JSON.parse(readFileSync(join(this.opts.spoolDir, f), "utf8"));
        this.opts.send({ seq, hook: typeof j.__hook === "string" ? j.__hook : "unknown", ts: typeof j.__ts === "number" ? j.__ts : 0, raw: j.__raw ?? {} });
      } catch { /* 文件损坏则跳过,等 ack 超时由人工清理 */ }
    }
    return files.length;
  }
}
