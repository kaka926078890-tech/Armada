import { describe, expect, test } from "bun:test";
import { TranscriptTailer } from "../src/transcript";

function fakeFs(initial = "") {
  let content = initial;
  return {
    append(s: string) { content += s; },
    readFile: (_path: string, offset: number) => ({ content: content.slice(offset), size: content.length }),
  };
}

describe("TranscriptTailer", () => {
  test("poll emits only new complete lines", () => {
    const fs = fakeFs('{"a":1}\n{"b":');
    const lines: string[] = [];
    const t = new TranscriptTailer({ readFile: fs.readFile, onLine: (_run, line) => lines.push(line) });
    t.attach("r1", "/tmp/t.jsonl");
    t.poll("r1");
    expect(lines).toEqual(['{"a":1}']);
    fs.append('2}\n{"c":3}\n');
    t.poll("r1");
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test("detach stops emission", () => {
    const fs = fakeFs("x\n");
    const lines: string[] = [];
    const t = new TranscriptTailer({ readFile: fs.readFile, onLine: (_r, l) => lines.push(l) });
    t.attach("r1", "/p");
    t.detach("r1");
    t.poll("r1");
    expect(lines).toHaveLength(0);
    expect(t.activeCount()).toBe(0);
  });

  test("multiple runs tracked independently", () => {
    const files: Record<string, string> = { "/a": "1\n", "/b": "2\n2\n" };
    const lines: [string, string][] = [];
    const t = new TranscriptTailer({
      readFile: (p, off) => ({ content: (files[p] ?? "").slice(off), size: (files[p] ?? "").length }),
      onLine: (r, l) => lines.push([r, l]),
    });
    t.attach("ra", "/a"); t.attach("rb", "/b");
    t.poll("ra"); t.poll("rb");
    expect(lines).toEqual([["ra", "1"], ["rb", "2"], ["rb", "2"]]);
  });

  test("re-attach same run+path keeps offset (followup must not replay history)", () => {
    const fs = fakeFs("old\n");
    const lines: string[] = [];
    const t = new TranscriptTailer({ readFile: fs.readFile, onLine: (_r, l) => lines.push(l) });
    t.attach("r1", "/p");
    t.poll("r1");
    t.attach("r1", "/p");
    fs.append("new\n");
    t.poll("r1");
    expect(lines).toEqual(["old", "new"]);
  });
});
