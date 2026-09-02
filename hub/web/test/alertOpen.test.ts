import { describe, expect, test } from "bun:test";
import { encodeWorkspaceKey } from "../src/boardState";
import { applyAlertOpen } from "../src/alertOpen";

describe("applyAlertOpen", () => {
  test("switches workspace and keeps the run id (unlike selectWorkspace)", () => {
    const next = applyAlertOpen({
      machineId: "m-b",
      workspaceRoot: "/ws/b",
      runId: "r-9",
    });
    expect(next.selectedWs).toBe(encodeWorkspaceKey("m-b", "/ws/b"));
    expect(next.selectedRun).toBe("r-9");
    expect(next.showArchived).toBe(false);
  });
});
