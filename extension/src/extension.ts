import * as vscode from "vscode";
import WebSocket from "ws";
import { randomUUID } from "crypto";
import { hostname } from "os";
import { loadConfig } from "./config";
import { WsClientCore } from "./wsClient";

let client: { dispose: () => void } | null = null;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("armada.configure", async () => {
    const hubUrl = await vscode.window.showInputBox({ prompt: "Armada hub host:port", placeHolder: "192.168.1.10:7380" });
    if (!hubUrl) return;
    const token = await vscode.window.showInputBox({ prompt: "Armada pairing token", password: true });
    if (!token) return;
    const cfg = vscode.workspace.getConfiguration("armada");
    await cfg.update("hubUrl", hubUrl, vscode.ConfigurationTarget.Global);
    await cfg.update("token", token, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Armada: saved. Reload window to connect.");
  }));

  const config = loadConfig();
  if (!config) return; // 未配置:静默待机

  let machineId = context.globalState.get<string>("armada.machineId");
  if (!machineId) {
    machineId = `m-${randomUUID()}`;
    void context.globalState.update("armada.machineId", machineId);
  }
  const windowId = vscode.env.sessionId;
  const workspaces = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  let ws: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  const core = new WsClientCore((msg) => ws?.send(JSON.stringify(msg)));

  const connect = () => {
    if (disposed) return;
    ws = new WebSocket(`ws://${config.hubUrl}/ws?token=${config.token}`);
    ws.on("open", () => {
      core.onOpen();
      core.enqueue({
        type: "register", machineId, windowId,
        name: hostname(), os: `${process.platform}-${process.arch}`,
        cursorVersion: vscode.version, extensionVersion: "0.1.0",
        openWorkspaces: workspaces(),
      });
      heartbeat = setInterval(() => core.enqueue({ type: "heartbeat", openWorkspaces: workspaces(), activeRunIds: [] }), 15_000);
    });
    ws.on("message", (data) => {
      // Task 9 接入 executor;本任务仅保证连接与注册
      void data;
    });
    ws.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      if (!disposed) reconnectTimer = setTimeout(connect, core.onClose());
    });
    ws.on("error", () => ws?.close());
  };
  connect();

  client = {
    dispose() {
      disposed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

export function deactivate(): void {
  client?.dispose();
  client = null;
}
