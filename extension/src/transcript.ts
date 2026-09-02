export interface TranscriptTailerOpts {
  readFile: (path: string, offset: number) => { content: string; size: number };
  onLine: (runId: string, line: string) => void;
}

export class TranscriptTailer {
  private tails = new Map<string, { path: string; offset: number; buf: string }>();
  constructor(private opts: TranscriptTailerOpts) {}

  attach(runId: string, path: string, opts?: { fromEnd?: boolean }): void {
    const existing = this.tails.get(runId);
    // 续聊会再次 bind 同一 run:不得把 offset 打回 0,否则整份 transcript 会重复灌进详情
    if (existing && existing.path === path) return;
    let offset = 0;
    if (opts?.fromEnd) {
      offset = this.opts.readFile(path, Number.MAX_SAFE_INTEGER).size;
    }
    this.tails.set(runId, { path, offset, buf: "" });
  }

  poll(runId: string): void {
    const t = this.tails.get(runId);
    if (!t) return;
    const { content, size } = this.opts.readFile(t.path, t.offset);
    t.offset = size;
    t.buf += content;
    let idx: number;
    while ((idx = t.buf.indexOf("\n")) >= 0) {
      const line = t.buf.slice(0, idx).trim();
      t.buf = t.buf.slice(idx + 1);
      if (line) this.opts.onLine(runId, line);
    }
  }

  detach(runId: string): void {
    this.tails.delete(runId);
  }

  activeCount(): number {
    return this.tails.size;
  }
}
