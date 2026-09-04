import * as vscode from "vscode";
import WebSocket from "ws";
import { randomUUID } from "crypto";
import { hostname, homedir } from "os";
import { readFileSync, openSync, readSync, closeSync, fstatSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "./config";
import { WsClientCore } from "./wsClient";
import { SpoolForwarder } from "./spool";
import { matchHookToPending, claimConversation, eventBelongsToWindow, transcriptPathBelongsToCid, runIdForHook, rememberSubagent, isAmbiguousMatch, dropPendingRuns, type PendingRun, type BindingMatch } from "./binding";
import { TranscriptTailer } from "./transcript";
import { Executor, CancelWatcher } from "./executor";
import { createCdpSubmitter, createImagePaster } from "./cdpInject";
import { writeOsImageClipboard } from "./osClipboard";
import { mergeHooks, hooksDriftHash, spoolScriptName, shouldInstallArmadaHooks } from "./hooksInstall";
import { collectTranscriptViews, matchTranscriptToPending, stopPayloadFromTranscriptLine, stopFromTranscriptFileContent, transcriptsDirForWorkspace, isWithinTranscriptBindWindow, FollowupStopGuard } from "./transcriptBind";
import { TranscriptDirWatcher, debounceLeading, watchTranscriptDir, watchFileSize, TRANSCRIPT_WATCHDOG_MS, TRANSCRIPT_WATCH_DEBOUNCE_MS } from "./transcriptWatch";
import { createExtSeq } from "./extSeq";
import { hubRunsNeedingTranscriptFollow } from "./adoptRuns";
import { noteOwnerBsp, clearGeneration, synthesizedStopPayload } from "./generationStamp";

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
  const lastGenerationId = new Map<string, string>();
  const boundPaths = new Map<string, string>();
  const stopSent = new Set<string>();
  const childConversations = new Map<string, string>();
  const sizeWatches = new Map<string, () => void>();
  const cancelWatcher = new CancelWatcher();
  const followupStopGuard = new FollowupStopGuard();

  const cdpSubmit = config.autoSubmit ? createCdpSubmitter({ port: config.cdpPort, log }) : null;
  const imagePaster = createImagePaster({ port: config.cdpPort, log });
  log(`autoSubmit=${config.autoSubmit} imagePaste=${config.imagePaste} cdpPort=${config.cdpPort}`);

  // transcript 事件走独立高段,避免与 spool seq 冲突。
  // 每次启动从时钟播种:不可再从 1e9 重数,否则 UNIQUE(machine_id, ext_seq) 把 stop 当重复丢掉。
  const nextExtSeq = createExtSeq();

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
      if (payload?.role === "user") {
        followupStopGuard.onUser(runId);
        stopSent.delete(runId);
      }
      core.enqueue({ type: "run.event", runId, source: "transcript", payload, ts: Date.now(), seq: nextExtSeq() });
      // Windows: stop hook 同样被 PS 5s 杀掉。合成 hub 已有的 stop 契约，不改 ingest。
      // 不 detach：续聊同一 path 才能保住 offset，避免重放旧 turn_ended 把 followup 立刻收口。
      if (process.platform !== "win32") return;
      const stop = stopPayloadFromTranscriptLine(line);
      if (!stop) return;
      emitSynthesizedStop(runId, stop);
    },
  });

  const emitSynthesizedStop = (runId: string, stop: { status: string; error?: string }): void => {
    if (!followupStopGuard.shouldEmitStop(runId)) return;
    if (stopSent.has(runId)) return;
    const owner = boundRuns.get(runId);
    const stamped = synthesizedStopPayload(stop, lastGenerationId.get(runId), owner?.conversationId);
    if (!stamped.ok) return;
    stopSent.add(runId);
    core.enqueue({
      type: "run.event",
      runId,
      conversationId: owner?.conversationId,
      source: "hook",
      hookEventName: "stop",
      payload: stamped.payload,
      ts: Date.now(),
      seq: nextExtSeq(),
    });
    log(`stop synthesized ${runId} status=${stop.status}`);
  };

  const maybeCompleteFromDisk = (runId: string): void => {
    if (process.platform !== "win32") return;
    if (!followupStopGuard.shouldEmitStop(runId)) return;
    const path = boundPaths.get(runId);
    if (!path) return;
    let content = "";
    try { content = readFileSync(path, "utf8"); } catch { return; }
    const stop = stopFromTranscriptFileContent(content);
    if (stop) emitSynthesizedStop(runId, stop);
    else stopSent.delete(runId);
  };

  const applyBinding = (match: BindingMatch, via: string): void => {
    const idx = pendingRuns.indexOf(match.run);
    if (idx >= 0) pendingRuns.splice(idx, 1);
    claimConversation(boundRuns, match.run.runId, match.conversationId, match.run.prompt);
    const path = match.transcriptPath && transcriptPathBelongsToCid(match.transcriptPath, match.conversationId)
      ? match.transcriptPath
      : null;
    const fromEnd = via === "followup";
    if (fromEnd) {
      followupStopGuard.arm(match.run.runId);
      stopSent.delete(match.run.runId);
      clearGeneration(lastGenerationId, match.run.runId);
    }
    core.enqueue({ type: "run.bound", runId: match.run.runId, conversationId: match.conversationId, transcriptPath: path, promptMatch: match.promptMatch });
    log(`run.bound ${match.run.runId} cid=${match.conversationId} via=${via}`);
    watchWorkspaceTranscripts(match.run.workspaceRoot);
    if (path) {
      boundPaths.set(match.run.runId, path);
      tailer.attach(match.run.runId, path, { fromEnd });
      tailer.poll(match.run.runId);
      sizeWatches.get(match.run.runId)?.();
      sizeWatches.set(match.run.runId, watchFileSize(path, () => {
        tailer.poll(match.run.runId);
        maybeCompleteFromDisk(match.run.runId);
      }));
      maybeCompleteFromDisk(match.run.runId);
    }
  };

  const tryBindFromTranscripts = (): void => {
    if (pendingRuns.length === 0) return;
    const boundCids = new Set([...boundRuns.values()].map((v) => v.conversationId));
    const files = [];
    const seen = new Set<string>();
    for (const run of pendingRuns) {
      if (!isWithinTranscriptBindWindow(run.dispatchedAt)) continue;
      const dir = transcriptsDirForWorkspace(homedir(), run.workspaceRoot);
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      files.push(...collectTranscriptViews(dir));
    }
    const match = matchTranscriptToPending(pendingRuns, files, { boundCids });
    if (isAmbiguousMatch(match)) {
      for (const run of match.runs) {
        core.enqueue({ type: "run.note", runId: run.runId, level: "error", message: "BIND_AMBIGUOUS" });
      }
      dropPendingRuns(pendingRuns, match.runs);
      return;
    }
    if (match) applyBinding(match, "transcript");
  };

  const onTranscriptDisk = debounceLeading(() => {
    tryBindFromTranscripts();
    for (const id of boundRuns.keys()) tailer.poll(id);
  }, TRANSCRIPT_WATCH_DEBOUNCE_MS);

  const dirWatch = new TranscriptDirWatcher({
    watch: watchTranscriptDir,
    onEvent: () => onTranscriptDisk(),
  });

  const watchWorkspaceTranscripts = (workspaceRoot: string): void => {
    const dir = transcriptsDirForWorkspace(homedir(), workspaceRoot);
    if (!dir) return;
    const n = dirWatch.watched().length;
    dirWatch.ensure(dir);
    if (dirWatch.watched().length !== n) log(`transcript watch ${dir}`);
  };

  const executor = new Executor({
    globalState: context.globalState,
    send: (m) => { log(`=> ${JSON.stringify(m)}`); core.enqueue(m); },
    addPending: (run) => {
      pendingRuns.push(run);
      watchWorkspaceTranscripts(run.workspaceRoot);
      tryBindFromTranscripts();
    },
    removePending: (runId) => {
      const i = pendingRuns.findIndex((r) => r.runId === runId);
      if (i >= 0) pendingRuns.splice(i, 1);
    },
    bindKnown: ({ runId, conversationId, workspaceRoot }) => {
      const run = pendingRuns.find((r) => r.runId === runId);
      if (!run) return;
      const dir = transcriptsDirForWorkspace(homedir(), workspaceRoot);
      const path = dir ? join(dir, conversationId, `${conversationId}.jsonl`) : null;
      applyBinding({
        run,
        conversationId,
        transcriptPath: path && existsSync(path) ? path : null,
        promptMatch: true,
      }, "followup");
    },
    autoSubmit: cdpSubmit
      ? async (workspaceRoot, prompt) => {
          const r = await cdpSubmit(workspaceRoot, prompt);
          if (!r.ok) log(`cdp submit failed: ${r.reason}; fallback to clipboard`);
          else log("cdp submit ok");
          return r.ok;
        }
      : undefined,
    imagePaste: config.imagePaste,
    autoEnter: config.autoSubmit,
    writeClipboard: writeOsImageClipboard,
    fetchBlob: async (id) => {
      const res = await fetch(`http://${config.hubUrl}/api/blobs/${id}`, {
        headers: { authorization: `Bearer ${config.token}` },
      });
      if (!res.ok) throw new Error(`blob ${res.status}`);
      const mime = res.headers.get("content-type") || "image/png";
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, mime };
    },
    autoSubmitImages: async (workspaceRoot, prompt, steps, autoSubmit) => {
      const r = await imagePaster(workspaceRoot, prompt, steps, writeOsImageClipboard, autoSubmit);
      if (!r.ok) log(`image paste failed: ${r.reason}`);
      else log("image paste ok");
      return r.ok;
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
      if (isAmbiguousMatch(match)) {
        for (const run of match.runs) {
          core.enqueue({ type: "run.note", runId: run.runId, level: "error", message: "BIND_AMBIGUOUS" });
        }
        dropPendingRuns(pendingRuns, match.runs);
      } else if (match) {
        applyBinding(match, "hook");
      }
      const reCancel = cancelWatcher.shouldCancelAgain({ hook: ev.hook, raw: ev.raw }, Date.now());
      if (reCancel) void executor.cancel(reCancel);
      rememberSubagent(childConversations, boundRuns, ev.hook, ev.raw);
      const cid = (ev.raw as any)?.conversation_id as string | undefined;
      const runId = (match && "run" in match ? match.run.runId : undefined)
        ?? runIdForHook(boundRuns, childConversations, cid);
      if (runId) {
        noteOwnerBsp(lastGenerationId, runId, ev.hook, ev.raw as any, boundRuns.get(runId)?.conversationId);
      }
      if (ev.hook === "stop" && runId) {
        const owner = boundRuns.get(runId);
        if (owner && owner.conversationId === cid) {
          tailer.detach(runId);
          sizeWatches.get(runId)?.();
          sizeWatches.delete(runId);
        }
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
    const hooksDir = join(homedir(), ".cursor", "hooks");
    let scriptPath = join(hooksDir, spoolScriptName());
    const bundled = join(context.extensionPath, "hooks", spoolScriptName());
    const bundledSh = join(context.extensionPath, "hooks", "armada-spool.sh");
    let installed = false;
    let drift = false;
    try {
      mkdirSync(hooksDir, { recursive: true });
      if (shouldInstallArmadaHooks(scriptPath)) {
        if (existsSync(bundled)) copyFileSync(bundled, scriptPath);
        else if (existsSync(bundledSh)) copyFileSync(bundledSh, scriptPath);
      }
      const existing = existsSync(hooksJsonPath) ? JSON.parse(readFileSync(hooksJsonPath, "utf8")) : null;
      const { merged, changed } = mergeHooks(existing, scriptPath);
      if (changed) {
        if (existsSync(hooksJsonPath)) copyFileSync(hooksJsonPath, `${hooksJsonPath}.bak.${Date.now()}`);
        writeFileSync(hooksJsonPath, JSON.stringify(merged, null, 2));
        if (!shouldInstallArmadaHooks(scriptPath)) log("windows: removed Armada hooks; bind via transcripts");
      } else {
        const expected = mergeHooks(null, scriptPath).merged;
        drift = hooksDriftHash(existing) !== hooksDriftHash(expected);
      }
      installed = shouldInstallArmadaHooks(scriptPath) ? existsSync(scriptPath) : true;
    } catch { installed = false; }
    core.enqueue({ type: "hooks.status", installed, version: "0.1.0", drift });
  };
  ensureHooks();

  const sendHeartbeat = () =>
    core.enqueue({ type: "heartbeat", openWorkspaces: workspaces(), activeRunIds: [...boundRuns.keys()] });

  const spoolPoll = setInterval(() => {
    forwarder.poll();
    tryBindFromTranscripts();
    for (const run of pendingRuns) watchWorkspaceTranscripts(run.workspaceRoot);
  }, 1000);
  const transcriptPoll = setInterval(() => {
    tryBindFromTranscripts();
    for (const id of boundRuns.keys()) {
      tailer.poll(id);
      maybeCompleteFromDisk(id);
    }
  }, TRANSCRIPT_WATCHDOG_MS);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => sendHeartbeat()));

  const adoptFromHub = async (): Promise<void> => {
    try {
      const res = await fetch(`http://${config.hubUrl}/api/runs`, {
        headers: { authorization: `Bearer ${config.token}` },
      });
      if (!res.ok) { log(`adopt runs http ${res.status}`); return; }
      const rows = await res.json() as unknown;
      if (!Array.isArray(rows)) return;
      const targets = hubRunsNeedingTranscriptFollow(machineId!, rows);
      for (const t of targets) {
        if (!boundRuns.has(t.runId)) {
          claimConversation(boundRuns, t.runId, t.conversationId, t.prompt);
          log(`adopt ${t.runId} cid=${t.conversationId}`);
        }
        const dir = transcriptsDirForWorkspace(homedir(), t.workspaceRoot);
        const path = dir ? join(dir, t.conversationId, `${t.conversationId}.jsonl`) : null;
        if (!path || !existsSync(path) || !transcriptPathBelongsToCid(path, t.conversationId)) continue;
        boundPaths.set(t.runId, path);
        followupStopGuard.arm(t.runId);
        stopSent.delete(t.runId);
        tailer.attach(t.runId, path, { fromEnd: true });
        tailer.poll(t.runId);
        sizeWatches.get(t.runId)?.();
        sizeWatches.set(t.runId, watchFileSize(path, () => {
          tailer.poll(t.runId);
          maybeCompleteFromDisk(t.runId);
        }));
        maybeCompleteFromDisk(t.runId);
      }
    } catch (e) {
      log(`adopt runs failed: ${String(e)}`);
    }
  };

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
        cursorVersion: vscode.version, extensionVersion: "0.4.16",
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
          void adoptFromHub();
          if (heartbeat) clearInterval(heartbeat);
          sendHeartbeat();
          heartbeat = setInterval(sendHeartbeat, 15_000);
          forwarder.resendUnacked();
          break;
        case "run.start":
          // pendingRuns is populated inside Executor after auth + newAgentChat (not here).
          void executor.startRun(msg).catch((e) => log(`startRun error: ${String(e)}`));
          break;
        case "run.cancel": {
          const b = boundRuns.get(msg.runId);
          clearGeneration(lastGenerationId, msg.runId);
          const cid = msg.conversationId ?? b?.conversationId;
          if (cid) {
            cancelWatcher.record(msg.runId, cid, b?.prompt ?? "", Date.now());
            void executor.cancel(cid).catch((e) => log(`cancel error: ${String(e)}`));
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
      dirWatch.dispose();
      for (const stop of sizeWatches.values()) stop();
      sizeWatches.clear();
      ws?.close();
    },
  };
}

export function deactivate(): void {
  client?.dispose();
  client = null;
}
