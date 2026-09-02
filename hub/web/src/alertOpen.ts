import { encodeWorkspaceKey } from "./boardState";

export type AlertOpen = {
  runId: string;
  machineId: string;
  workspaceRoot: string;
};

export type AlertOpenView = {
  selectedWs: string;
  selectedRun: string;
  showArchived: false;
};

/** 切到该卡工作区并打开详情。禁止走会清空 selectedRun 的 selectWorkspace。 */
export function applyAlertOpen(alert: AlertOpen): AlertOpenView {
  return {
    selectedWs: encodeWorkspaceKey(alert.machineId, alert.workspaceRoot),
    selectedRun: alert.runId,
    showArchived: false,
  };
}
