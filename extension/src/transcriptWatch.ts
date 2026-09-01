import { watch, watchFile, unwatchFile } from "fs";

export const TRANSCRIPT_WATCHDOG_MS = 7_000;
export const TRANSCRIPT_WATCH_DEBOUNCE_MS = 50;
/** Windows fs.watch often misses appends to a file Cursor keeps open. Stat the jsonl while tailed. */
export const TRANSCRIPT_TAIL_POLL_MS = 300;

export class TranscriptDirWatcher {
  private stoppers = new Map<string, () => void>();
  constructor(private opts: {
    watch: (dir: string, onEvent: () => void) => () => void;
    onEvent: (dir: string) => void;
  }) {}

  ensure(dir: string): void {
    if (this.stoppers.has(dir)) return;
    this.stoppers.set(dir, this.opts.watch(dir, () => this.opts.onEvent(dir)));
  }

  watched(): string[] {
    return [...this.stoppers.keys()];
  }

  dispose(): void {
    for (const stop of this.stoppers.values()) {
      try { stop(); } catch { /* ignore */ }
    }
    this.stoppers.clear();
  }
}

/** First call runs now; later calls in the window collapse to one trailing run. */
export function debounceLeading(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  return () => {
    if (!timer) {
      fn();
      timer = setTimeout(() => {
        timer = null;
        if (!pending) return;
        pending = false;
        fn();
        timer = setTimeout(() => { timer = null; }, ms);
      }, ms);
      return;
    }
    pending = true;
  };
}

export function watchTranscriptDir(dir: string, onEvent: () => void): () => void {
  try {
    const w = watch(dir, { recursive: true }, () => onEvent());
    w.on("error", () => { /* directory removed; watchdog poll still runs */ });
    return () => { try { w.close(); } catch { /* ignore */ } };
  } catch {
    return () => {};
  }
}

/** Size polling: sees appends that directory watch misses on Windows. */
export function watchFileSize(path: string, onGrow: () => void, intervalMs: number = TRANSCRIPT_TAIL_POLL_MS): () => void {
  watchFile(path, { interval: intervalMs, persistent: false }, (curr, prev) => {
    if (curr.size > prev.size) onGrow();
  });
  return () => { try { unwatchFile(path); } catch { /* ignore */ } };
}
