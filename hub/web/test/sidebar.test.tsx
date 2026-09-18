import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Sidebar from "../src/components/Sidebar";
import { extensionLagNotice, REQUIRED_EXTENSION_VERSION, encodeWorkspaceKey, type WorkspaceSlot } from "../src/boardState";

const slot: WorkspaceSlot = {
  machineId: "m-win",
  machineName: "Win Destop",
  os: "win32",
  root: "c:\\Users\\PC\\Desktop\\work",
  online: true,
  cdpReady: true,
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
          extension_version: "0.4.23", open_workspaces: "[]", status: "online", last_seen_at: 1,
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

describe("Sidebar inject gate", () => {
  test("cdpReady false disables dispatch", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        slots={[{ ...slot, cdpReady: false }]}
        machines={[{
          id: "m-win", name: "PF39WTSM", os: "win32", cursor_version: "1.128.0",
          extension_version: REQUIRED_EXTENSION_VERSION, open_workspaces: "[]", status: "online", last_seen_at: 1,
          display_name: "Win Destop",
        }]}
        allRuns={[]}
        selectedKey={encodeWorkspaceKey(slot.machineId, slot.root)}
        onSelectWorkspace={() => {}}
        readMap={{}}
        onDispatch={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("派发任务");
  });

  test("desktop actions include 修复调试口", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        slots={[slot]}
        machines={[{
          id: "m-win", name: "PF39WTSM", os: "win32", cursor_version: "1.128.0",
          extension_version: REQUIRED_EXTENSION_VERSION, open_workspaces: "[]", status: "online", last_seen_at: 1,
        }]}
        allRuns={[]}
        selectedKey={encodeWorkspaceKey(slot.machineId, slot.root)}
        onSelectWorkspace={() => {}}
        readMap={{}}
        onDispatch={() => {}}
        onRename={() => {}}
        showDesktopActions
        onOpenWorkspace={() => {}}
        onRepairCdp={() => {}}
        onGetShareLink={() => {}}
      />,
    );
    expect(html).toContain("修复调试口");
    expect(html).toContain("打开工作区");
  });
});
