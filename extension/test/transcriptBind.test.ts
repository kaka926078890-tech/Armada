import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isAmbiguousMatch, type PendingRun } from "../src/binding";
import {
  conversationIdFromTranscriptPath,
  cursorProjectSlug,
  extractFirstUserPrompt,
  listLeafTranscripts,
  matchTranscriptToPending,
  stopPayloadFromTranscriptLine,
  transcriptsDirForWorkspace,
  isWithinTranscriptBindWindow,
  TRANSCRIPT_BIND_WINDOW_MS,
  stopFromTranscriptFileContent,
} from "../src/transcriptBind";

const CID = "c9597541-e291-40c9-9041-772c292acc24";
const P: PendingRun = {
  runId: "r-1",
  workspaceRoot: "c:\\Users\\PC\\Desktop\\work",
  prompt: "你好v2",
  dispatchedAt: 1_000_000,
};

const WRAP = [
  `{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Monday, Aug 31, 2026, 5:30 PM (UTC+8)</timestamp>\\n<user_query>\\n你好v2\\n</user_query>"}]}}`,
  `{"role":"assistant","message":{"content":[{"type":"text","text":"你好。"}]}}`,
].join("\n");

describe("extractFirstUserPrompt", () => {
  test("pulls user_query out of Cursor wrapper tags", () => {
    expect(extractFirstUserPrompt(WRAP)).toBe("你好v2");
  });

  test("plain user text still binds", () => {
    expect(extractFirstUserPrompt(`{"role":"user","message":{"content":[{"type":"text","text":"hello"}]}}`)).toBe("hello");
  });

  test("skips assistant lines until a user line exists", () => {
    const jsonl = `{"role":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n{"role":"user","message":{"content":[{"type":"text","text":"task"}]}}\n`;
    expect(extractFirstUserPrompt(jsonl)).toBe("task");
  });
});

describe("conversationIdFromTranscriptPath", () => {
  test("accepts leaf jsonl and rejects subagents", () => {
    const leaf = `c:/Users/PC/.cursor/projects/c-Users-PC-Desktop-work/agent-transcripts/${CID}/${CID}.jsonl`;
    expect(conversationIdFromTranscriptPath(leaf)).toBe(CID);
    expect(conversationIdFromTranscriptPath(
      `c:/Users/PC/.cursor/projects/c-Users-PC-Desktop-work/agent-transcripts/${CID}/subagents/child.jsonl`,
    )).toBeNull();
  });
});

describe("cursorProjectSlug", () => {
  test("Windows drive paths become c-Users-... slug", () => {
    expect(cursorProjectSlug("c:\\Users\\PC\\Desktop\\work")).toBe("c-Users-PC-Desktop-work");
    expect(cursorProjectSlug("C:/Users/PC/Desktop/work")).toBe("c-Users-PC-Desktop-work");
  });
});

describe("matchTranscriptToPending", () => {
  const file = {
    path: `/proj/agent-transcripts/${CID}/${CID}.jsonl`,
    mtimeMs: 1_002_000,
    firstPrompt: "你好v2",
    conversationId: CID,
  };

  test("unique prompt in time window binds", () => {
    const m = matchTranscriptToPending([P], [file]);
    expect(m && "run" in m ? m.run.runId : null).toBe("r-1");
    expect(m && "conversationId" in m ? m.conversationId : null).toBe(CID);
    expect(m && "transcriptPath" in m ? m.transcriptPath : null).toBe(file.path);
  });

  test("jsonl written 22s after dispatch still matches (mtime has no upper bound)", () => {
    const late = { ...file, mtimeMs: P.dispatchedAt + 22_000 };
    const m = matchTranscriptToPending([P], [late]);
    expect(m && "run" in m ? m.run.runId : null).toBe("r-1");
  });

  test("ignores transcripts older than dispatch minus 5s", () => {
    expect(matchTranscriptToPending([P], [{ ...file, mtimeMs: 990_000 }])).toBeNull();
  });

  test("two pending with the same prompt do not guess", () => {
    const older = { ...P, runId: "r-old", dispatchedAt: 999_000 };
    const newer = { ...P, runId: "r-new", dispatchedAt: 1_000_000 };
    const m = matchTranscriptToPending([newer, older], [file]);
    expect(m).toMatchObject({ ambiguous: true });
  });

  test("skips a conversation already bound", () => {
    expect(matchTranscriptToPending([P], [file], { boundCids: new Set([CID]) })).toBeNull();
  });

  test("two pending with different prompts are not ambiguous", () => {
    const a = { ...P, runId: "r-a", prompt: "alpha", dispatchedAt: 1_000_000 };
    const b = { ...P, runId: "r-b", prompt: "beta", dispatchedAt: 1_000_000 };
    const files = [
      { ...file, firstPrompt: "alpha", conversationId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", path: "/p/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jsonl" },
      { ...file, firstPrompt: "beta", conversationId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", path: "/p/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.jsonl" },
    ];
    const m = matchTranscriptToPending([a, b], files);
    expect(isAmbiguousMatch(m)).toBe(false);
    expect(m && "run" in m ? m.run.runId : null).toBe("r-a");
  });
});

describe("listLeafTranscripts", () => {
  test("finds cid/cid.jsonl and skips subagents", () => {
    const root = mkdtempSync(join(tmpdir(), "armada-tx-"));
    mkdirSync(join(root, CID), { recursive: true });
    mkdirSync(join(root, CID, "subagents"), { recursive: true });
    const leaf = join(root, CID, `${CID}.jsonl`);
    writeFileSync(leaf, WRAP);
    writeFileSync(join(root, CID, "subagents", "child.jsonl"), "{}");
    expect(listLeafTranscripts(root).sort()).toEqual([leaf]);
  });
});

describe("transcriptsDirForWorkspace", () => {
  test("resolves slug dir when it exists (drive-letter case ignored)", () => {
    const home = mkdtempSync(join(tmpdir(), "armada-home-"));
    const slug = join(home, ".cursor", "projects", "c-Users-PC-Desktop-work", "agent-transcripts");
    mkdirSync(slug, { recursive: true });
    expect(transcriptsDirForWorkspace(home, "C:\\Users\\PC\\Desktop\\work")).toBe(slug);
  });
});

describe("stopPayloadFromTranscriptLine", () => {
  test("turn_ended success maps to hub stop completed", () => {
    expect(stopPayloadFromTranscriptLine(`{"type":"turn_ended","status":"success"}`)).toEqual({ status: "completed" });
  });

  test("turn_ended aborted maps to hub stop aborted", () => {
    expect(stopPayloadFromTranscriptLine(`{"type":"turn_ended","status":"aborted"}`)).toEqual({ status: "aborted" });
  });

  test("assistant/user lines are not stop", () => {
    expect(stopPayloadFromTranscriptLine(`{"role":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`)).toBeNull();
    expect(stopPayloadFromTranscriptLine(`{"role":"user","message":{"content":[{"type":"text","text":"x"}]}}`)).toBeNull();
  });
});

describe("stopFromTranscriptFileContent", () => {
  test("last turn_ended line completes even if earlier lines were already tailed", () => {
    const body = [
      `{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}`,
      `{"role":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}`,
      `{"type":"turn_ended","status":"success"}`,
      ``,
    ].join("\n");
    expect(stopFromTranscriptFileContent(body)).toEqual({ status: "completed" });
  });

  test("a new user line after turn_ended means the turn is no longer finished", () => {
    const body = [
      `{"type":"turn_ended","status":"success"}`,
      `{"role":"user","message":{"content":[{"type":"text","text":"followup"}]}}`,
    ].join("\n");
    expect(stopFromTranscriptFileContent(body)).toBeNull();
  });
});

describe("isWithinTranscriptBindWindow", () => {
  test("keeps scanning past 20s so a late jsonl still binds before hub BIND_TIMEOUT", () => {
    expect(TRANSCRIPT_BIND_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
    expect(isWithinTranscriptBindWindow(0, 22_000)).toBe(true);
    expect(isWithinTranscriptBindWindow(0, 59_000)).toBe(true);
  });

  test("still scans a few seconds after hub BIND_TIMEOUT so a late run.bound can resurrect", () => {
    expect(isWithinTranscriptBindWindow(0, 61_000)).toBe(true);
    expect(isWithinTranscriptBindWindow(0, 71_000)).toBe(false);
  });
});
