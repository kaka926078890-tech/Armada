import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Board from "../src/components/Board";
import { extensionLagNotice, type RunRow } from "../src/boardState";

const run: RunRow = {
  id: "r-1", machine_id: "m-1", window_id: "w-1", workspace_root: "/ws/a",
  prompt: "修好了", status: "completed", conversation_id: "c1",
  transcript_path: null, parent_run_id: null, created_at: 1000, started_at: 2000,
  ended_at: 5000, end_reason: "completed",
};

describe("Board unread chrome", () => {
  test("unread completed card has a green accent, not a red one", () => {
    const html = renderToStaticMarkup(
      <Board
        runs={[run]}
        machines={[{ id: "m-1", name: "Mac-A", os: "darwin", cursor_version: null, extension_version: null, open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("border-l-emerald-400");
    expect(html).not.toContain("border-l-red-400");
    expect(html).not.toContain("shadow-[");
  });

  test("opened completed card has no green accent", () => {
    const html = renderToStaticMarkup(
      <Board
        runs={[run]}
        machines={[{ id: "m-1", name: "Mac-A", os: "darwin", cursor_version: null, extension_version: null, open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{ "r-1": 9000 }}
        onRename={() => {}}
      />,
    );
    expect(html).not.toContain("border-l-emerald-400");
    expect(html).not.toContain("border-l-red-400");
  });

  test("pending ask card has a red accent even after it was opened", () => {
    const html = renderToStaticMarkup(
      <Board
        runs={[{ ...run, status: "running", ended_at: null, end_reason: null, pending_ask: { request_id: "ask-1", questions: [{ id: "q0", prompt: "选一个", options: [] }] } }]}
        machines={[{ id: "m-1", name: "Mac-A", os: "darwin", cursor_version: null, extension_version: null, open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{ "r-1": 9000 }}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("border-l-red-400");
    expect(html).not.toContain("border-l-emerald-400");
  });

  test("unread error card has a red accent like completed has green", () => {
    const html = renderToStaticMarkup(
      <Board
        runs={[{ ...run, status: "error", end_reason: "REJECTED", conversation_id: null }]}
        machines={[{ id: "m-1", name: "Mac-A", os: "darwin", cursor_version: null, extension_version: null, open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{}}
        onRename={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("border-l-red-400");
    expect(html).not.toContain("border-l-emerald-400");
    expect(html).toContain("data-col-alert=\"error\"");
    expect(html).toContain("bg-red-400");
  });

  test("quiet mode turns the error dot gray and leaves the red status bar", () => {
    const html = renderToStaticMarkup(
      <Board
        runs={[{ ...run, status: "error", end_reason: "REJECTED", conversation_id: null }]}
        machines={[{ id: "m-1", name: "Mac-A", os: "darwin", cursor_version: null, extension_version: null, open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{}}
        onRename={() => {}}
        onRetry={() => {}}
        quietUnread
      />,
    );
    expect(html).toContain("bg-zinc-400");
    expect(html).not.toContain("bg-red-400");
    expect(html).toContain("border-l-red-400");
    expect(html).toContain("data-col-alert=\"error\"");
  });

  test("error card shows a retry button", () => {
    const html = renderToStaticMarkup(
      <Board
        runs={[{ ...run, status: "error", end_reason: "REJECTED", conversation_id: null }]}
        machines={[{ id: "m-1", name: "Mac-A", os: "darwin", cursor_version: null, extension_version: null, open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{ "r-1": 9000 }}
        onRename={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("重试");
    expect(html).not.toContain("absolute top-1.5 right-1.5");
    expect(html).not.toContain("pr-16");
  });

  test("long card title is clamped and actions sit after the body", () => {
    const prompt = `${"超长提示词".repeat(20)}结尾`;
    const html = renderToStaticMarkup(
      <Board
        runs={[{ ...run, prompt }]}
        machines={[{ id: "m-1", name: "Mac-A", os: "darwin", cursor_version: null, extension_version: null, open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{}}
        onRename={() => {}}
      />,
    );
    expect(html).toMatch(/line-clamp-2/);
    expect(html).toContain(`title="${prompt}"`);
    expect(html).toContain(`>${"超长提示词".repeat(8)}…<`);
    expect(html).not.toMatch(new RegExp(`>${prompt}<`));
    const titleAt = html.indexOf("超长提示词");
    const actionsAt = html.indexOf("改标题");
    expect(titleAt).toBeGreaterThan(-1);
    expect(actionsAt).toBeGreaterThan(titleAt);
  });

  test("card on a stale Windows extension does not repeat the vsix gap", () => {
    const html = renderToStaticMarkup(
      <Board
        runs={[run]}
        machines={[{ id: "m-1", name: "Win Destop", os: "win32", cursor_version: "1.128.0", extension_version: "0.4.18", open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{}}
        onRename={() => {}}
      />,
    );
    expect(html).not.toContain(extensionLagNotice("0.4.18")!);
  });

  test("running card shows a spinner next to the badge", () => {
    const html = renderToStaticMarkup(
      <Board
        runs={[{ ...run, status: "running", ended_at: null, end_reason: null }]}
        machines={[{ id: "m-1", name: "Mac-A", os: "darwin", cursor_version: null, extension_version: null, open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("任务执行中");
    expect(html).toContain("animate-spin");
  });

  test("resume stall card tells the operator to follow up from the hub", () => {
    const html = renderToStaticMarkup(
      <Board
        runs={[{
          ...run,
          status: "error",
          end_reason: "Agent turn stopped after repeated resume attempts made no progress",
        }]}
        machines={[{ id: "m-1", name: "Mac-A", os: "darwin", cursor_version: null, extension_version: null, open_workspaces: "[]", status: "online", last_seen_at: 1 }]}
        selected={null}
        onSelect={() => {}}
        showArchived={false}
        onHide={() => {}}
        onUnhide={() => {}}
        readMap={{}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("本机 Resume 会自己消失");
    expect(html).toContain("发一条续聊");
  });
});
