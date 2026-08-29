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
  /**
   * 全自动提交(CDP DOM 注入)。返回 true 表示提示词已写入并提交;
   * 返回 false 或抛错时降级为剪贴板粘贴 + 人工回车。
   */
  autoSubmit?: (workspaceRoot: string, prompt: string) => Promise<boolean>;
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

  async startRun(msg: { runId: string; workspaceRoot: string; prompt: string; dispatchedAt?: number }): Promise<void> {
    const vscode = vs();
    // 过期派发守卫:hub 侧 30s 无 ack 即 DISPATCH_TIMEOUT 进终态;
    // 若 modal 被搁置超过该时长才点"允许",注入已无意义且会污染绑定(真机联调实测)。
    if (typeof msg.dispatchedAt === "number" && Date.now() - msg.dispatchedAt > 30_000) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "STALE_DISPATCH" });
      return;
    }
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
      await this.injectPrompt(msg.workspaceRoot, msg.prompt, 1500);
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "accepted" });
    } catch (e) {
      if (pendingAdded) this.deps.removePending?.(msg.runId);
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: `INJECT_FAILED:${String(e)}` });
    }
  }

  /**
   * CDP 写入并回车;失败则剪贴板粘贴后再试一次 CDP(此时草稿已在新框里,走 DRAFT→Enter)。
   * 第二次仍失败则停在"已粘贴待回车"。
   */
  private async injectPrompt(workspaceRoot: string, prompt: string, pasteWaitMs: number): Promise<void> {
    const vscode = vs();
    let submitted = false;
    if (this.deps.autoSubmit) {
      try {
        submitted = await this.deps.autoSubmit(workspaceRoot, prompt);
      } catch {
        submitted = false;
      }
    }
    if (!submitted) {
      await this.sleep(pasteWaitMs);
      await vscode.env.clipboard.writeText(prompt);
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      if (this.deps.autoSubmit) {
        try {
          submitted = await this.deps.autoSubmit(workspaceRoot, prompt);
        } catch {
          submitted = false;
        }
      }
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
      await this.injectPrompt(msg.workspaceRoot, msg.prompt, 800);
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
