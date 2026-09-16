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
  test("completed unread card has a red ring, not only a 6px dot", () => {
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
    expect(html).toContain("border-red-500");
    expect(html).toContain("shadow-[");
    expect(html).toContain("bg-red-500");
  });

  test("opened completed card does not keep the red ring", () => {
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
    expect(html).not.toContain("border-red-500");
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
  });

  test("card on a stale Windows extension names the vsix gap", () => {
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
    expect(html).toContain(extensionLagNotice("0.4.18")!);
  });
});
