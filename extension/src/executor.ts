import type { PendingRun } from "./binding";

export class CancelWatcher {
  private records = new Map<string, { cid: string; prompt: string; at: number; count: number }>();

  record(runId: string, conversationId: string, prompt: string, nowMs: number): void {
    this.records.set(runId, { cid: conversationId, prompt, at: nowMs, count: 0 });
  }

  shouldCancelAgain(ev: { hook: string; raw: any }, nowMs: number): string | null {
    if (ev.hook !== "beforeSubmitPrompt") return null;
    for (const [runId, r] of this.records) {
      if (ev.raw?.conversation_id !== r.cid) continue;
      if (ev.raw?.prompt !== r.prompt) continue;
      if (nowMs - r.at > 20_000) { this.records.delete(runId); continue; }
      if (r.count >= 2) return null;
      r.count += 1;
      return r.cid;
    }
    return null;
  }
}

export interface ExecutorDeps {
  globalState: {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
  };
  send: (msg: object) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Called after auth passes and newAgentChat succeeds — binding window starts here. */
  addPending?: (run: PendingRun) => void;
  /** Drop a pending entry on INJECT_FAILED after it was already added. */
  removePending?: (runId: string) => void;
}

/** Lazy-load vscode so CancelWatcher stays bun-testable without the vscode runtime. */
function vs(): typeof import("vscode") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("vscode");
}

export class Executor {
  private sleep: (ms: number) => Promise<void>;
  constructor(private deps: ExecutorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private authorizedWorkspaces(): string[] {
    return this.deps.globalState.get<string[]>("armada.authorizedWorkspaces", []) ?? [];
  }

  async startRun(msg: { runId: string; workspaceRoot: string; prompt: string }): Promise<void> {
    const vscode = vs();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (!folders.includes(msg.workspaceRoot)) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "WRONG_WINDOW" });
      return;
    }
    if (!this.authorizedWorkspaces().includes(msg.workspaceRoot)) {
      const choice = await vscode.window.showInformationMessage(
        `Armada 请求向工作区 ${msg.workspaceRoot} 注入任务`, { modal: true }, "允许", "拒绝",
      );
      if (choice !== "允许") {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "NOT_AUTHORIZED" });
        return;
      }
      await this.deps.globalState.update("armada.authorizedWorkspaces", [...this.authorizedWorkspaces(), msg.workspaceRoot]);
    }
    let pendingAdded = false;
    try {
      await vscode.commands.executeCommand("composer.newAgentChat");
      // Auth passed + chat created: binding window starts; WRONG_WINDOW/NOT_AUTHORIZED never reach here.
      this.deps.addPending?.({
        runId: msg.runId,
        workspaceRoot: msg.workspaceRoot,
        prompt: msg.prompt,
        dispatchedAt: Date.now(),
      });
      pendingAdded = true;
      await this.sleep(1500);
      await vscode.env.clipboard.writeText(msg.prompt);
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "accepted" });
    } catch (e) {
      if (pendingAdded) this.deps.removePending?.(msg.runId);
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: `INJECT_FAILED:${String(e)}` });
    }
  }

  async cancel(conversationId: string): Promise<void> {
    await vs().commands.executeCommand("composer.cancelChat", conversationId);
  }

  async followup(msg: {
    runId: string;
    conversationId: string;
    prompt: string;
    /** Present on hub `run.followup` (parent workspace); required for pending binding. */
    workspaceRoot: string;
  }): Promise<void> {
    const vscode = vs();
    try {
      await vscode.commands.executeCommand("composer.openComposer", msg.conversationId);
      await this.sleep(800);
      await vscode.env.clipboard.writeText(msg.prompt);
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      // Binding window starts after inject succeeds (mirrors startRun post-auth pending).
      this.deps.addPending?.({
        runId: msg.runId,
        workspaceRoot: msg.workspaceRoot,
        prompt: msg.prompt,
        dispatchedAt: Date.now(),
      });
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "accepted" });
    } catch (e) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: `FOLLOWUP_FAILED:${String(e)}` });
    }
  }
}
