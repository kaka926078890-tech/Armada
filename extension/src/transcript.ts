export interface TranscriptTailerOpts {
  readFile: (path: string, offset: number) => { content: string; size: number };
  onLine: (runId: string, line: string, meta: { path: string }) => void;
}

/**
 * Transcript tail lifetime is the cid bind, not the first owner `stop`.
 * Background Task completion appends a follow-up turn after `turn_ended`;
 * unfollowing on owner-cid stop drops that assistant body from Armada.
 */
export function shouldUnfollowOnHookStop(_args: {
  hook: string;
  ownerConversationId: string | undefined;
  eventConversationId: string | undefined;
}): boolean {
  return false;
}

export class TranscriptTailer {
  private tails = new Map<string, { runId: string; path: string; offset: number; buf: string }>();
  constructor(private opts: TranscriptTailerOpts) {}

  private key(runId: string, path: string): string {
    return `${runId}\0${path}`;
  }

  attach(runId: string, path: string, opts?: { fromEnd?: boolean }): void {
    const k = this.key(runId, path);
    const existing = this.tails.get(k);
    // 续聊会再次 bind 同一 run+path:不得把 offset 打回 0,否则整份 transcript 会重复灌进详情
    if (existing) return;
    let offset = 0;
    if (opts?.fromEnd) {
      offset = this.opts.readFile(path, Number.MAX_SAFE_INTEGER).size;
    }
    this.tails.set(k, { runId, path, offset, buf: "" });
  }

  poll(runId: string): void {
    for (const t of this.tails.values()) {
      if (t.runId !== runId) continue;
      const { content, size } = this.opts.readFile(t.path, t.offset);
      t.offset = size;
      t.buf += content;
      let idx: number;
      while ((idx = t.buf.indexOf("\n")) >= 0) {
        const line = t.buf.slice(0, idx).trim();
        t.buf = t.buf.slice(idx + 1);
        if (line) this.opts.onLine(runId, line, { path: t.path });
      }
    }
  }

  detach(runId: string): void {
    for (const [k, t] of this.tails) {
      if (t.runId === runId) this.tails.delete(k);
    }
  }

  activeCount(): number {
    return this.tails.size;
  }
}
