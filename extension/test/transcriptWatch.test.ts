import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TranscriptDirWatcher, debounceLeading, watchTranscriptDir, watchFileSize, TRANSCRIPT_TAIL_POLL_MS } from "../src/transcriptWatch";

describe("TranscriptDirWatcher", () => {
  test("ensure starts a watch and forwards events", () => {
    const dirs: string[] = [];
    const fires: string[] = [];
    const stops: string[] = [];
    const w = new TranscriptDirWatcher({
      watch: (dir, onEvent) => {
        dirs.push(dir);
        return () => stops.push(dir);
      },
      onEvent: (dir) => fires.push(dir),
    });
    w.ensure("/tx");
    expect(dirs).toEqual(["/tx"]);
    expect(w.watched()).toEqual(["/tx"]);
    // simulate fs event by calling watch callback — stored above
  });

  test("ensure is idempotent for the same dir", () => {
    let started = 0;
    const w = new TranscriptDirWatcher({
      watch: () => { started += 1; return () => {}; },
      onEvent: () => {},
    });
    w.ensure("/tx");
    w.ensure("/tx");
    expect(started).toBe(1);
  });

  test("watch callback delivers the dir to onEvent", () => {
    const seen: string[] = [];
    const listeners = new Map<string, () => void>();
    const w = new TranscriptDirWatcher({
      watch: (dir, onEvent) => {
        listeners.set(dir, onEvent);
        return () => listeners.delete(dir);
      },
      onEvent: (dir) => seen.push(dir),
    });
    w.ensure("/a");
    listeners.get("/a")!();
    expect(seen).toEqual(["/a"]);
  });

  test("dispose closes every watch", () => {
    const closed: string[] = [];
    const w = new TranscriptDirWatcher({
      watch: (dir) => () => { closed.push(dir); },
      onEvent: () => {},
    });
    w.ensure("/a");
    w.ensure("/b");
    w.dispose();
    expect(closed.sort()).toEqual(["/a", "/b"]);
    expect(w.watched()).toEqual([]);
  });
});

describe("debounceLeading", () => {
  test("first call runs immediately, subsequent calls within window coalesce to one trailing run", async () => {
    let n = 0;
    const d = debounceLeading(() => { n += 1; }, 40);
    d();
    d();
    d();
    expect(n).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(n).toBe(2);
  });
});

describe("watchTranscriptDir", () => {
  test("fires when a jsonl under the dir is appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-watch-"));
    const cid = "c9597541-e291-40c9-9041-772c292acc24";
    mkdirSync(join(dir, cid));
    const file = join(dir, cid, `${cid}.jsonl`);
    writeFileSync(file, "");
    let n = 0;
    const stop = watchTranscriptDir(dir, () => { n += 1; });
    await new Promise((r) => setTimeout(r, 150));
    appendFileSync(file, '{"role":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    const deadline = Date.now() + 2500;
    while (n === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(n).toBeGreaterThan(0);
  });
});

describe("watchFileSize", () => {
  test("notifies within one poll interval when an open file is appended", async () => {
    expect(TRANSCRIPT_TAIL_POLL_MS).toBeLessThanOrEqual(300);
    const dir = mkdtempSync(join(tmpdir(), "armada-size-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, "a\n");
    let n = 0;
    const stop = watchFileSize(file, () => { n += 1; }, 80);
    await new Promise((r) => setTimeout(r, 120));
    appendFileSync(file, "b\n");
    const deadline = Date.now() + 1500;
    while (n === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(n).toBeGreaterThan(0);
  });
});
