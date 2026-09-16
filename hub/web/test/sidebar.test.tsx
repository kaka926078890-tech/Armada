import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Sidebar from "../src/components/Sidebar";
import { extensionLagNotice, REQUIRED_EXTENSION_VERSION, type WorkspaceSlot } from "../src/boardState";

const slot: WorkspaceSlot = {
  machineId: "m-win",
  machineName: "Win Destop",
  os: "win32",
  root: "c:\\Users\\PC\\Desktop\\work",
  online: true,
};

describe("Sidebar extension lag", () => {
  test("stale vsix shows under the machine name", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        slots={[slot]}
        machines={[{
          id: "m-win", name: "PF39WTSM", os: "win32", cursor_version: "1.128.0",
          extension_version: "0.4.18", open_workspaces: "[]", status: "online", last_seen_at: 1,
          display_name: "Win Destop",
        }]}
        allRuns={[]}
        selectedKey={null}
        onSelectWorkspace={() => {}}
        readMap={{}}
        onDispatch={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain(extensionLagNotice("0.4.18")!);
  });

  test("current vsix is silent", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        slots={[slot]}
        machines={[{
          id: "m-win", name: "PF39WTSM", os: "win32", cursor_version: "1.128.0",
          extension_version: "0.4.21", open_workspaces: "[]", status: "online", last_seen_at: 1,
          display_name: "Win Destop",
        }]}
        allRuns={[]}
        selectedKey={null}
        onSelectWorkspace={() => {}}
        readMap={{}}
        onDispatch={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).not.toContain(`需 ${REQUIRED_EXTENSION_VERSION}`);
  });
});
