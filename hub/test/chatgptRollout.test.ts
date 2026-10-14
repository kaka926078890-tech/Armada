import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { runToSnap } from "../src/relayClient";
import type { RunEvent } from "../web/src/types";

const THREAD = "01a12ed8-13e1-7e91-b59b-0f48c0b150f4";
const TURN = "01a12ed9-cd13-7741-aa09-0d10f417de2c";
const USER = "请执行 python3 -c \"import time\\nfor i in range(1,20):\\n print(i, flush=True)\\n time.sleep(1)\" 标记 armada-bg-2";
const FINAL = "已执行完成，标记：`armada-bg-2`。\n\n输出为 `1` 到 `19`，进程退出码为 `0`。";

const userLine = JSON.stringify({
  timestamp: "2026-10-12T08:25:50.940Z",
  type: "event_msg",
  payload: {
    type: "item_completed",
    thread_id: THREAD,
    turn_id: TURN,
    item: { type: "UserMessage", content: [{ type: "text", text: USER + "\n" }] },
  },
});
const completeLine = JSON.stringify({
  type: "event_msg",
  payload: { type: "task_complete", turn_id: TURN, last_agent_message: FINAL },
});

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-chatgpt-"));
  hub = createServer({ port: 0, home });
  hub.db.query("INSERT INTO machines (id, name, os, open_workspaces) VALUES ('m-1','Mac','darwin','[]')").run();
  hub.db.query(
    `INSERT INTO runs (id, machine_id, workspace_root, prompt, status, created_at, started_at)
     VALUES ('r-1','m-1','chatgpt:desk',?1,'running',?2,?2)`,
  ).run(USER, Date.parse("2026-10-12T08:25:45.513Z"));
  const api = (path: string) => fetch(`http://127.0.0.1:${hub!.port}${path}`, {
    headers: { authorization: `Bearer ${hub!.token}` },
  });
  return { api };
}

describe("chatgpt rollout on the hub card", () => {
  test("a user line binds the thread and does not finish the card", () => {
    const { api } = start();
    hub!.runs.noteChatgptRollout("r-1", userLine);
    const run = hub!.runs.get("r-1");
    expect(run.status).toBe("running");
    expect(run.chatgpt_thread_id).toBe(THREAD);
    expect(run.chatgpt_turn_id).toBe(TURN);
    expect(run.conversation_id).toBeNull();
    return api("/api/runs/r-1/chat").then(async (res) => {
      const body = await res.json() as { turns: { role: string; text: string }[] };
      expect(body.turns).toEqual([{ role: "user", text: USER }]);
    });
  });

  test("task_complete while another page is current still fills this card", async () => {
    const { api } = start();
    hub!.runs.noteChatgptRollout("r-1", `${userLine}\n${completeLine}`);
    hub!.runs.noteChatgptRollout("r-1", `${userLine}\n${completeLine}`);
    const run = hub!.runs.get("r-1");
    expect(run.status).toBe("completed");
    expect(run.conversation_id).toBeNull();
    const chat = await (await api("/api/runs/r-1/chat")).json() as { turns: { role: string; text: string }[] };
    expect(chat.turns).toEqual([
      { role: "user", text: USER },
      { role: "assistant", text: FINAL },
    ]);
    const events = hub!.db.query("SELECT * FROM run_events WHERE run_id=?1 ORDER BY seq").all("r-1") as RunEvent[];
    expect(runToSnap(run, events).finalText).toBe(FINAL);
    expect(runToSnap(run, events).conversationId).toBeNull();
    expect(runToSnap(run, events).chatgptThreadId).toBe(THREAD);
  });

  test("an older finished turn with the same prompt does not complete this dispatch", () => {
    const home = mkdtempSync(join(tmpdir(), "armada-chatgpt-"));
    hub = createServer({ port: 0, home });
    const started = Date.parse("2026-10-12T08:25:45.513Z");
    hub.db.query("INSERT INTO machines (id, name, os, open_workspaces) VALUES ('m-1','Mac','darwin','[]')").run();
    hub.db.query(
      `INSERT INTO runs (id, machine_id, workspace_root, prompt, status, created_at, started_at)
       VALUES ('r-1','m-1','chatgpt:desk','你好','binding',?1,?1)`,
    ).run(started);
    const old = [
      JSON.stringify({
        timestamp: "2026-10-12T08:16:35.382Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: "01a12f2e-fdd9-7472-bf54-e635cf817b56",
          turn_id: "01a12f2f-5c0e-7701-abf2-f1e9880cf173",
          item: { type: "UserMessage", content: [{ type: "text", text: "你好\n" }] },
        },
      }),
      JSON.stringify({
        timestamp: "2026-10-12T08:16:54.091Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "01a12f2f-5c0e-7701-abf2-f1e9880cf173",
          last_agent_message: "你好！我在这儿。你想写代码、看项目、查资料，还是先随便聊两句都行。",
        },
      }),
    ].join("\n");
    hub.runs.noteChatgptRollout("r-1", old);
    expect(hub.runs.get("r-1").status).toBe("binding");
    expect(hub.runs.get("r-1").chatgpt_thread_id).toBeNull();

    const liveUser = JSON.stringify({
      timestamp: "2026-10-12T08:25:50.940Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "01a12f37-c717-7ba2-b5bf-217ad28472ff",
        turn_id: "01a12f37-c8-20f9825007df",
        item: { type: "UserMessage", content: [{ type: "text", text: "你好\n" }] },
      },
    });
    hub.runs.noteChatgptRollout("r-1", liveUser);
    expect(hub.runs.get("r-1").status).toBe("running");

    const liveDone = liveUser + "\n" + JSON.stringify({
      timestamp: "2026-10-12T08:25:53.818Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "01a12f37-c8-20f9825007df",
        last_agent_message: "你好！我在这儿。你想让我看代码、改东西、做个 review，还是先一起理一理思路？",
      },
    });
    hub.runs.noteChatgptRollout("r-1", liveDone);
    const run = hub.runs.get("r-1");
    expect(run.status).toBe("completed");
    expect(run.chatgpt_thread_id).toBe("01a12f37-c717-7ba2-b5bf-217ad28472ff");
  });
});
