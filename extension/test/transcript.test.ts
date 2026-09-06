import { describe, expect, test } from "bun:test";
import { shouldUnfollowOnHookStop, TranscriptTailer } from "../src/transcript";

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

  test("attach fromEnd skips existing lines (new window followup must not replay turn_ended)", () => {
    const fs = fakeFs('{"type":"turn_ended","status":"success"}\n');
    const lines: string[] = [];
    const t = new TranscriptTailer({ readFile: fs.readFile, onLine: (_r, l) => lines.push(l) });
    t.attach("r1", "/p", { fromEnd: true });
    t.poll("r1");
    expect(lines).toEqual([]);
    fs.append('{"role":"user"}\n{"type":"turn_ended","status":"success"}\n');
    t.poll("r1");
    expect(lines).toEqual(['{"role":"user"}', '{"type":"turn_ended","status":"success"}']);
  });

  test("same run can tail parent jsonl and a subagent jsonl independently", () => {
    const files: Record<string, string> = {
      "/parent.jsonl": '{"role":"assistant"}\n',
      "/subagents/child.jsonl": '{"role":"user"}\n{"role":"assistant","text":"review"}\n',
    };
    const lines: [string, string, string][] = [];
    const t = new TranscriptTailer({
      readFile: (p, off) => ({ content: (files[p] ?? "").slice(off), size: (files[p] ?? "").length }),
      onLine: (r, l, meta) => lines.push([r, meta.path, l]),
    });
    t.attach("r1", "/parent.jsonl");
    t.attach("r1", "/subagents/child.jsonl");
    t.poll("r1");
    expect(t.activeCount()).toBe(2);
    expect(lines).toEqual([
      ["r1", "/parent.jsonl", '{"role":"assistant"}'],
      ["r1", "/subagents/child.jsonl", '{"role":"user"}'],
      ["r1", "/subagents/child.jsonl", '{"role":"assistant","text":"review"}'],
    ]);
  });
});

describe("shouldUnfollowOnHookStop", () => {
  test("owner-cid stop does not unfollow: background Task follow-up still grows the same jsonl", () => {
    // Real hook (r-0f0eadc6 seq 2282): parent stop.conversation_id === run.conversation_id
    // after launching run_in_background Tasks. Old code unfollowed here and dropped
    // the later assistant body ("web 审查 已完成").
    expect(shouldUnfollowOnHookStop({
      hook: "stop",
      ownerConversationId: "a746cf16-81d3-4fe7-8d57-67903fb845a8",
      eventConversationId: "a746cf16-81d3-4fe7-8d57-67903fb845a8",
    })).toBe(false);
  });
});
