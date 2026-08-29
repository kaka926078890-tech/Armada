import * as vscode from "vscode";
import WebSocket from "ws";
import { randomUUID } from "crypto";
import { hostname, homedir } from "os";
import { readFileSync, openSync, readSync, closeSync, fstatSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "./config";
import { WsClientCore } from "./wsClient";
import { SpoolForwarder } from "./spool";
import { matchHookToPending, type PendingRun } from "./binding";
import { TranscriptTailer } from "./transcript";
import { Executor, CancelWatcher } from "./executor";
import { mergeHooks, hooksDriftHash } from "./hooksInstall";

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

  const armadaDir = join(homedir(), ".cursor", "armada");
  const spoolDir = join(armadaDir, "spool");
  mkdirSync(spoolDir, { recursive: true });

  const pendingRuns: PendingRun[] = [];
  const boundRuns = new Map<string, { conversationId: string; prompt: string }>();
  const cancelWatcher = new CancelWatcher();

  const executor = new Executor({
    globalState: context.globalState,
    send: (m) => core.enqueue(m),
    addPending: (run) => { pendingRuns.push(run); },
    removePending: (runId) => {
      const i = pendingRuns.findIndex((r) => r.runId === runId);
      if (i >= 0) pendingRuns.splice(i, 1);
    },
  });

  // transcript 事件走独立高段,避免与 spool seq 冲突
  let extSeq = 1_000_000_000;
  const nextExtSeq = () => { extSeq += 1; return extSeq; };

  const tailer = new TranscriptTailer({
    readFile: (path, offset) => {
      try {
        const fd = openSync(path, "r");
        const size = fstatSync(fd).size;
        const len = Math.max(0, size - offset);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, offset);
        closeSync(fd);
        return { content: buf.toString("utf8"), size };
      } catch { return { content: "", size: offset }; }
    },
    onLine: (runId, line) => {
      let payload: any = { __raw_line: line };
      try { payload = JSON.parse(line); } catch { /* 保留原始行 */ }
      core.enqueue({ type: "run.event", runId, source: "transcript", payload, ts: Date.now(), seq: nextExtSeq() });
    },
  });

  const forwarder = new SpoolForwarder({
    spoolDir, stateDir: armadaDir,
    send: (ev) => {
      // 绑定判定优先于转发
      const match = matchHookToPending(pendingRuns, { hook: ev.hook, ts: ev.ts, raw: ev.raw });
      if (match) {
        pendingRuns.splice(pendingRuns.indexOf(match.run), 1);
        boundRuns.set(match.run.runId, { conversationId: match.conversationId, prompt: match.run.prompt });
        core.enqueue({ type: "run.bound", runId: match.run.runId, conversationId: match.conversationId, transcriptPath: match.transcriptPath, promptMatch: match.promptMatch });
        if (match.transcriptPath) tailer.attach(match.run.runId, match.transcriptPath);
      }
      const reCancel = cancelWatcher.shouldCancelAgain({ hook: ev.hook, raw: ev.raw }, Date.now());
      if (reCancel) void executor.cancel(reCancel);
      // 事件归属:优先 match 到的 runId,否则按 conversation_id 反查
      const runId = match?.run.runId
        ?? [...boundRuns.entries()].find(([, v]) => v.conversationId === (ev.raw as any)?.conversation_id)?.[0];
      core.enqueue({
        type: "run.event", runId, conversationId: (ev.raw as any)?.conversation_id,
        source: "hook", hookEventName: ev.hook, payload: ev.raw, ts: ev.ts * 1000, seq: ev.seq,
      });
    },
  });

  // hooks 安装检查 + drift 上报
  const ensureHooks = () => {
    const hooksJsonPath = join(homedir(), ".cursor", "hooks.json");
    const scriptPath = join(homedir(), ".cursor", "hooks", "armada-spool.sh");
    let installed = false;
    let drift = false;
    try {
      const existing = existsSync(hooksJsonPath) ? JSON.parse(readFileSync(hooksJsonPath, "utf8")) : null;
      const { merged, changed } = mergeHooks(existing, scriptPath);
      if (changed) {
        if (existsSync(hooksJsonPath)) copyFileSync(hooksJsonPath, `${hooksJsonPath}.bak.${Date.now()}`);
        writeFileSync(hooksJsonPath, JSON.stringify(merged, null, 2));
      } else {
        // Compare against expected canonical entries, not merge-of-existing (which is a no-op copy when unchanged).
        const expected = mergeHooks(null, scriptPath).merged;
        drift = hooksDriftHash(existing) !== hooksDriftHash(expected);
      }
      // installed means spool script is present; changed only means hooks.json was repaired.
      installed = existsSync(scriptPath);
    } catch { installed = false; }
    core.enqueue({ type: "hooks.status", installed, version: "0.1.0", drift });
  };
  ensureHooks();

  const tailerActive = () => [...boundRuns.keys()];
  const spoolPoll = setInterval(() => forwarder.poll(), 1000);
  const transcriptPoll = setInterval(() => { for (const id of tailerActive()) tailer.poll(id); }, 2000);

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
      forwarder.resendUnacked();
      heartbeat = setInterval(() => core.enqueue({ type: "heartbeat", openWorkspaces: workspaces(), activeRunIds: [...boundRuns.keys()] }), 15_000);
    });
    ws.on("message", (data) => {
      let msg: any;
      try { msg = JSON.parse(String(data)); } catch { return; }
      switch (msg.type) {
        case "run.start":
          // pendingRuns is populated inside Executor after auth + newAgentChat (not here).
          void executor.startRun(msg);
          break;
        case "run.cancel": {
          const b = boundRuns.get(msg.runId);
          const cid = msg.conversationId ?? b?.conversationId;
          if (cid) {
            cancelWatcher.record(msg.runId, cid, b?.prompt ?? "", Date.now());
            void executor.cancel(cid);
          }
          break;
        }
        case "run.followup":
          void executor.followup(msg);
          break;
        case "event.ack":
          forwarder.ack(msg.lastSeq);
          break;
      }
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
      clearInterval(spoolPoll);
      clearInterval(transcriptPoll);
      ws?.close();
    },
  };
}

export function deactivate(): void {
  client?.dispose();
  client = null;
}
