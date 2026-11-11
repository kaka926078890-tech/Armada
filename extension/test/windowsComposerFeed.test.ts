import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWindowsComposerFeed } from "../src/windowsComposerFeed";

const cid = "251e2de9-fef2-4ef9-aadd-663258b24116";
const bubbleId = "aa287f49-6f3b-4c12-972d-9da1fc11d66b";
const gen = "6bc4f02c-7ae3-4e80-a2b3-b8f613605ee7";

function db() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, createdAt INTEGER, isSubagent INTEGER, value TEXT);
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
  `);
  sqlite.query("INSERT INTO composerHeaders (composerId, createdAt, isSubagent, value) VALUES (?1,?2,0,?3)").run(
    cid, 1_000, JSON.stringify({ workspaceIdentifier: { uri: { fsPath: "c:\\Users\\PC\\Desktop\\work" } } }),
  );
  sqlite.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`composerData:${cid}`, JSON.stringify({
    status: "aborted", chatGenerationUUID: gen, fullConversationHeadersOnly: [], subagentComposerIds: [],
  }));
  sqlite.query("INSERT INTO cursorDiskKV (key, value) VALUES (?1,?2)").run(`bubbleId:${cid}:${bubbleId}`, JSON.stringify({
    type: 1, text: "probe", requestId: gen,
  }));
  return sqlite;
}

describe("windows composer feed", () => {
  test("binds the createNew composer and does not stop while its uuid is set", async () => {
    const sqlite = db();
    const binds: string[] = [];
    const hooks: Array<string | null> = [];
    const feed = createWindowsComposerFeed({
      enabled: true,
      open: async () => ({ db: sqlite, close: () => {} }),
      onBind: (_run, conversationId) => { binds.push(conversationId); },
      onEvent: (_runId, ev) => { hooks.push(ev.hook); },
    });
    feed.note({
      runId: "r-1", workspaceRoot: "C:\\Users\\PC\\Desktop\\work", prompt: "probe",
      dispatchedAt: 2_000, anchorAt: 1_000,
    });
    await feed.poll();
    expect(binds).toEqual([cid]);
    expect(hooks).toContain("beforeSubmitPrompt");
    expect(hooks).not.toContain("stop");
    sqlite.close();
  });

  test("reload watches the known composer without a new createNew anchor", async () => {
    const sqlite = db();
    const hooks: Array<string | null> = [];
    const feed = createWindowsComposerFeed({
      enabled: true,
      open: async () => ({ db: sqlite, close: () => {} }),
      onBind: () => { throw new Error("reload must not bind a second composer"); },
      onEvent: (_runId, ev) => { hooks.push(ev.hook); },
    });
    feed.watch("r-1", cid);
    await feed.poll();
    expect(hooks).toContain("beforeSubmitPrompt");
    expect(hooks).not.toContain("stop");
    sqlite.close();
  });
});
