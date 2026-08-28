import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SpoolForwarder, type OutboundEvent } from "../src/spool";

function setup() {
  const spoolDir = mkdtempSync(join(tmpdir(), "armada-spoolq-"));
  const stateDir = mkdtempSync(join(tmpdir(), "armada-state-"));
  const sent: OutboundEvent[] = [];
  const f = new SpoolForwarder({ spoolDir, stateDir, send: (e) => sent.push(e) });
  return { spoolDir, stateDir, sent, f };
}

function drop(spoolDir: string, name: string, doc: object) {
  writeFileSync(join(spoolDir, name), JSON.stringify(doc));
}

describe("SpoolForwarder", () => {
  test("poll assigns monotonic seq, renames file, sends parsed event", () => {
    const { spoolDir, sent, f } = setup();
    drop(spoolDir, "100-a.json", { __hook: "sessionStart", __ts: 100, __raw: { conversation_id: "c1" } });
    drop(spoolDir, "101-b.json", { __hook: "stop", __ts: 101, __raw: { status: "completed" } });
    expect(f.poll()).toBe(2);
    expect(sent.map((e) => [e.seq, e.hook])).toEqual([[1, "sessionStart"], [2, "stop"]]);
    const files = readdirSync(spoolDir).sort();
    expect(files).toEqual(["1-100-a.json", "2-101-b.json"]);
  });

  test("seq persists across instances (no reuse after crash)", () => {
    const { spoolDir, stateDir, sent, f } = setup();
    drop(spoolDir, "100-a.json", { __hook: "stop", __ts: 1, __raw: {} });
    f.poll();
    const f2 = new SpoolForwarder({ spoolDir, stateDir, send: (e) => sent.push(e) });
    drop(spoolDir, "102-c.json", { __hook: "stop", __ts: 2, __raw: {} });
    f2.poll();
    expect(sent.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("unparseable file is forwarded as __unparsed, not dropped", () => {
    const { spoolDir, sent, f } = setup();
    writeFileSync(join(spoolDir, "x.json"), "{broken");
    expect(f.poll()).toBe(1);
    expect(sent[0].hook).toBe("unknown");
    expect(String(sent[0].raw.__unparsed)).toContain("{broken");
  });

  test("ack deletes files with seq <= lastSeq", () => {
    const { spoolDir, f } = setup();
    drop(spoolDir, "a.json", { __hook: "stop", __ts: 1, __raw: {} });
    drop(spoolDir, "b.json", { __hook: "stop", __ts: 2, __raw: {} });
    drop(spoolDir, "c.json", { __hook: "stop", __ts: 3, __raw: {} });
    expect(f.poll()).toBe(3);
    expect(f.ack(2)).toBe(2);
    expect(readdirSync(spoolDir).sort()).toEqual(["3-c.json"]);
  });

  test("resendUnacked replays assigned files in seq order", () => {
    const { spoolDir, stateDir, sent, f } = setup();
    drop(spoolDir, "a.json", { __hook: "stop", __ts: 1, __raw: {} });
    drop(spoolDir, "b.json", { __hook: "stop", __ts: 2, __raw: {} });
    f.poll();
    const sent2: OutboundEvent[] = [];
    const f2 = new SpoolForwarder({ spoolDir, stateDir, send: (e) => sent2.push(e) });
    expect(f2.resendUnacked()).toBe(2);
    expect(sent2.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("poll is idempotent on already-assigned files", () => {
    const { spoolDir, sent, f } = setup();
    drop(spoolDir, "a.json", { __hook: "stop", __ts: 1, __raw: {} });
    expect(f.poll()).toBe(1);
    expect(f.poll()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("empty/corrupt seq file recovers from spool max prefix (no reuse)", () => {
    const { spoolDir, stateDir, sent, f } = setup();
    drop(spoolDir, "a.json", { __hook: "stop", __ts: 1, __raw: {} });
    drop(spoolDir, "b.json", { __hook: "stop", __ts: 2, __raw: {} });
    expect(f.poll()).toBe(2);
    // Simulate crash truncation: seq file exists but empty
    writeFileSync(join(stateDir, "seq"), "");
    const sent2: OutboundEvent[] = [];
    const f2 = new SpoolForwarder({ spoolDir, stateDir, send: (e) => sent2.push(e) });
    drop(spoolDir, "c.json", { __hook: "stop", __ts: 3, __raw: {} });
    expect(f2.poll()).toBe(1);
    expect(sent2.map((e) => e.seq)).toEqual([3]);
    expect(readdirSync(spoolDir).sort()).toEqual(["1-a.json", "2-b.json", "3-c.json"]);
    expect(sent).toHaveLength(2); // prior instance unchanged
  });

  test("resendUnacked forwards unparsable assigned files as __unparsed", () => {
    const { spoolDir, stateDir, f } = setup();
    drop(spoolDir, "a.json", { __hook: "stop", __ts: 1, __raw: {} });
    expect(f.poll()).toBe(1);
    // Corrupt the already-assigned file after rename (crash between rename and send)
    writeFileSync(join(spoolDir, "1-a.json"), "{broken");
    const sent2: OutboundEvent[] = [];
    const f2 = new SpoolForwarder({ spoolDir, stateDir, send: (e) => sent2.push(e) });
    expect(f2.resendUnacked()).toBe(1);
    expect(sent2).toHaveLength(1);
    expect(sent2[0].seq).toBe(1);
    expect(sent2[0].hook).toBe("unknown");
    expect(String(sent2[0].raw.__unparsed)).toContain("{broken");
  });
});
