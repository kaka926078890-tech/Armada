import * as vscode from "vscode";
import WebSocket from "ws";
import { randomUUID } from "crypto";
import { hostname, homedir } from "os";
import { readFileSync, openSync, readSync, closeSync, fstatSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "./config";
import { WsClientCore } from "./wsClient";
import { SpoolForwarder } from "./spool";
import { matchHookToPending, claimConversation, eventBelongsToWindow, transcriptPathBelongsToCid, runIdForHook, rememberSubagent, type PendingRun } from "./binding";
import { TranscriptTailer } from "./transcript";
import { Executor, CancelWatcher } from "./executor";
import { createCdpSubmitter } from "./cdpInject";
import { mergeHooks, hooksDriftHash, spoolScriptName } from "./hooksInstall";

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

  const out = vscode.window.createOutputChannel("Armada");
  const log = (s: string) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`);
  context.subscriptions.push(out);

  const config = loadConfig();
  if (!config) { log("no armada.hubUrl/token configured; dormant"); return; }
  log(`config loaded, hub=${config.hubUrl}`);

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

  const core = new WsClientCore(
    (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
    () => ws?.readyState === WebSocket.OPEN,
  );

  const armadaDir = join(homedir(), ".cursor", "armada");
  const spoolDir = join(armadaDir, "spool");
  mkdirSync(spoolDir, { recursive: true });

  const pendingRuns: PendingRun[] = [];
  const boundRuns = new Map<string, { conversationId: string; prompt: string }>();
  const childConversations = new Map<string, string>();
  const cancelWatcher = new CancelWatcher();

  const cdpSubmit = config.autoSubmit ? createCdpSubmitter({ port: config.cdpPort, log }) : null;
  log(`autoSubmit=${config.autoSubmit} cdpPort=${config.cdpPort}`);

  const executor = new Executor({
    globalState: context.globalState,
    send: (m) => { log(`=> ${JSON.stringify(m)}`); core.enqueue(m); },
    addPending: (run) => { pendingRuns.push(run); },
    removePending: (runId) => {
      const i = pendingRuns.findIndex((r) => r.runId === runId);
      if (i >= 0) pendingRuns.splice(i, 1);
    },
    autoSubmit: cdpSubmit
      ? async (workspaceRoot, prompt) => {
          const r = await cdpSubmit(workspaceRoot, prompt);
          if (!r.ok) log(`cdp submit failed: ${r.reason}; fallback to clipboard`);
          else log("cdp submit ok");
          return r.ok;
        }
      : undefined,
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
    shouldClaim: (ev) => eventBelongsToWindow(ev.raw, workspaces())
      || !!matchHookToPending(pendingRuns, { hook: ev.hook, ts: ev.ts, raw: ev.raw })
      || !!runIdForHook(boundRuns, childConversations, ev.raw?.conversation_id as string | undefined),
    send: (ev) => {
      // 绑定判定优先于转发
      const match = matchHookToPending(pendingRuns, { hook: ev.hook, ts: ev.ts, raw: ev.raw });
      if (match) {
        pendingRuns.splice(pendingRuns.indexOf(match.run), 1);
        claimConversation(boundRuns, match.run.runId, match.conversationId, match.run.prompt);
        const path = match.transcriptPath && transcriptPathBelongsToCid(match.transcriptPath, match.conversationId)
          ? match.transcriptPath
          : null;
        core.enqueue({ type: "run.bound", runId: match.run.runId, conversationId: match.conversationId, transcriptPath: path, promptMatch: match.promptMatch });
        if (path) tailer.attach(match.run.runId, path);
      }
      const reCancel = cancelWatcher.shouldCancelAgain({ hook: ev.hook, raw: ev.raw }, Date.now());
      if (reCancel) void executor.cancel(reCancel);
      rememberSubagent(childConversations, boundRuns, ev.hook, ev.raw);
      const cid = (ev.raw as any)?.conversation_id as string | undefined;
      const runId = match?.run.runId ?? runIdForHook(boundRuns, childConversations, cid);
      if (ev.hook === "stop" && runId) {
        const owner = boundRuns.get(runId);
        if (owner && owner.conversationId === cid) tailer.detach(runId);
      }
      core.enqueue({
        type: "run.event", runId, conversationId: cid,
        source: "hook", hookEventName: ev.hook, payload: ev.raw, ts: ev.ts * 1000, seq: ev.seq,
      });
    },
  });

  // hooks 安装检查 + drift 上报
  const ensureHooks = () => {
    const hooksJsonPath = join(homedir(), ".cursor", "hooks.json");
    const scriptPath = join(homedir(), ".cursor", "hooks", spoolScriptName());
    const bundled = join(context.extensionPath, "hooks", spoolScriptName());
    let installed = false;
    let drift = false;
    try {
      mkdirSync(join(homedir(), ".cursor", "hooks"), { recursive: true });
      if (existsSync(bundled)) copyFileSync(bundled, scriptPath);
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
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    const prev = ws;
    ws = null;
    if (prev) {
      prev.removeAllListeners();
      if (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING) {
        try { prev.close(); } catch { /* ignore */ }
      }
    }
    const sock = new WebSocket(`ws://${config.hubUrl}/ws?token=${config.token}`);
    ws = sock;
    sock.on("open", () => {
      if (ws !== sock) return;
      log("ws open, registering");
      core.onOpen();
      core.sendRegister({
        type: "register", machineId, windowId,
        name: hostname(), os: `${process.platform}-${process.arch}`,
        cursorVersion: vscode.version, extensionVersion: "0.4.0",
        openWorkspaces: workspaces(),
      });
    });
    sock.on("message", (data) => {
      if (ws !== sock) return;
      let msg: any;
      try { msg = JSON.parse(String(data)); } catch { return; }
      log(`<= ${msg.type} ${msg.runId ?? ""}`);
      switch (msg.type) {
        case "registered":
          core.onRegistered();
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = setInterval(() => core.enqueue({ type: "heartbeat", openWorkspaces: workspaces(), activeRunIds: [...boundRuns.keys()] }), 15_000);
          forwarder.resendUnacked();
          break;
        case "run.start":
          // pendingRuns is populated inside Executor after auth + newAgentChat (not here).
          void executor.startRun(msg).catch((e) => log(`startRun error: ${String(e)}`));
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
    sock.on("close", (code, reason) => {
      if (ws !== sock) return;
      log(`ws closed code=${code} ${reason}`);
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (!disposed) reconnectTimer = setTimeout(connect, core.onClose());
    });
    sock.on("error", (e) => {
      if (ws !== sock) return;
      log(`ws error: ${String(e)}`);
      sock.close();
    });
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
