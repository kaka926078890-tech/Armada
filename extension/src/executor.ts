import { homedir } from "os";
import { join } from "path";
import type { PendingRun } from "./binding";
import { acquireCdpLock } from "./cdpLock";
import { workspacePathIn } from "./workspacePath";

const CANCEL_RECORD_WINDOW_MS = 20_000;

/**
 * 一次 `beforeSubmitPrompt` 归属于 Armada 自身注入的时间宽限。
 * spool → forwarder 轮询为 1s（`extension.ts` 的 `spoolPoll`）；5s 给积压留 5 倍余量。
 */
const INJECT_ATTRIBUTION_MS = 5_000;

export class CancelWatcher {
  private records = new Map<string, { cid: string; prompt: string; at: number; count: number }>();
  /** Armada 自己最后一次把 prompt 提交进 composer 的时刻，按 runId。 */
  private lastInjectAt = new Map<string, number>();

  /** Called by Executor right after our own submit lands (CDP enter or clipboard paste). */
  noteInjection(runId: string, nowMs: number): void {
    for (const [id, at] of this.lastInjectAt) {
      if (nowMs - at > CANCEL_RECORD_WINDOW_MS) this.lastInjectAt.delete(id);
    }
    this.lastInjectAt.set(runId, nowMs);
  }

  record(runId: string, conversationId: string, prompt: string, nowMs: number): void {
    this.records.set(runId, { cid: conversationId, prompt, at: nowMs, count: 0 });
  }

  shouldCancelAgain(ev: { hook: string; raw: any }, nowMs: number): string | null {
    if (ev.hook !== "beforeSubmitPrompt") return null;
    for (const [runId, r] of this.records) {
      if (ev.raw?.conversation_id !== r.cid) continue;
      if (ev.raw?.prompt !== r.prompt) continue;
      if (nowMs - r.at > CANCEL_RECORD_WINDOW_MS) { this.records.delete(runId); continue; }
      // 只有 Armada 自己迟到的注入才归我们收拾。人手动重发同一段文字形状一致
      // （同 cid、同 prompt、全新 generation_id），取消它会打断用户自己的轮次。
      const injectedAt = this.lastInjectAt.get(runId);
      if (injectedAt === undefined || nowMs - injectedAt > INJECT_ATTRIBUTION_MS) continue;
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
  /** Our own submit landed. Only such submits may be re-cancelled after run.cancel. */
  onInjected?: (runId: string) => void;
  /**
   * 全自动提交(CDP DOM 注入)。true / `{ ok:true }` 表示已写入并回车。
   * `NON_EMPTY_INPUT*`：框里是别人的草稿/引用芯片，禁止剪贴板往里贴。
   * 其它失败：降级剪贴板粘贴（无 CDP 时仍靠人工回车）。
   */
  autoSubmit?: (workspaceRoot: string, prompt: string) => Promise<boolean | { ok: boolean; reason?: string }>;
  imagePaste?: boolean;
  fetchBlob?: (id: string) => Promise<{ bytes: Buffer; mime: string }>;
  writeClipboard?: (bytes: Buffer, mime: string) => void;
  autoSubmitImages?: (
    workspaceRoot: string,
    prompt: string,
    steps: { bytes: Buffer; mime: string }[],
    autoSubmit: boolean,
  ) => Promise<boolean>;
  autoEnter?: boolean;
  /**
   * Called when conversation_id is already known (followup) so we do not wait for hooks.
   */
  bindKnown?: (args: { runId: string; conversationId: string; prompt: string; workspaceRoot: string }) => void;
  /** Override path of the machine-wide CDP inject lock (tests / non-default home). */
  cdpLockPath?: string;
  answerAskCdp?: (args: {
    workspaceRoot: string;
    action: "continue" | "skip";
    letter?: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
}

/** Lazy-load vscode so CancelWatcher stays bun-testable without the vscode runtime. */
function vs(): typeof import("vscode") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("vscode");
}

function autoSubmitOutcome(r: boolean | { ok: boolean; reason?: string }): { ok: boolean; reason?: string } {
  if (typeof r === "boolean") return { ok: r };
  return { ok: !!r.ok, reason: r.reason };
}

function isDirtyComposer(reason?: string): boolean {
  return typeof reason === "string" && reason.startsWith("NON_EMPTY_INPUT");
}

export class Executor {
  private sleep: (ms: number) => Promise<void>;
  constructor(private deps: ExecutorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private authorizedWorkspaces(): string[] {
    return this.deps.globalState.get<string[]>("armada.authorizedWorkspaces", []) ?? [];
  }

  async startRun(msg: {
    runId: string; workspaceRoot: string; prompt: string; dispatchedAt?: number;
    attachments?: { id?: string; sha256?: string; mime?: string; size?: number; name?: string }[];
  }): Promise<void> {
    const vscode = vs();
    // 过期派发守卫:hub 侧 30s 无 ack 即 DISPATCH_TIMEOUT 进终态;
    // 若 modal 被搁置超过该时长才点"允许",注入已无意义且会污染绑定(真机联调实测)。
    if (typeof msg.dispatchedAt === "number" && Date.now() - msg.dispatchedAt > 30_000) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "STALE_DISPATCH" });
      return;
    }
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (attachments.length && this.deps.imagePaste === false) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "IMAGE_PASTE_DISABLED" });
      return;
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (!workspacePathIn(msg.workspaceRoot, folders)) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "WRONG_WINDOW" });
      return;
    }
    if (!workspacePathIn(msg.workspaceRoot, this.authorizedWorkspaces())) {
      const choice = await vscode.window.showInformationMessage(
        `Armada 请求向工作区 ${msg.workspaceRoot} 注入任务`, { modal: true }, "允许", "拒绝",
      );
      if (choice !== "允许") {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "NOT_AUTHORIZED" });
        return;
      }
      await this.deps.globalState.update("armada.authorizedWorkspaces", [...this.authorizedWorkspaces(), msg.workspaceRoot]);
    }
    const lock = await acquireCdpLock({
      lockPath: this.deps.cdpLockPath ?? join(homedir(), ".cursor", "armada", "cdp.lock"),
      timeoutMs: 25_000,
      sleep: this.sleep,
    });
    if (!lock.ok) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "CDP_LOCK_TIMEOUT" });
      return;
    }
    let pendingAdded = false;
    try {
      // createNew = 空对话。newAgentChat 会把活动编辑器做成引用芯片（真机
      // NON_EMPTY_INPUT:windows-packaging-self-hosted-）；其前再 focus 编辑器组会把用户挪开的焦点抢回去。
      await vscode.commands.executeCommand("composer.createNew");
      // Auth passed + chat created: binding window starts; WRONG_WINDOW/NOT_AUTHORIZED never reach here.
      this.deps.addPending?.({
        runId: msg.runId,
        workspaceRoot: msg.workspaceRoot,
        prompt: msg.prompt,
        dispatchedAt: Date.now(),
        attachmentIds: attachments.map((a) => a.sha256 || a.id).filter((x): x is string => !!x),
      });
      pendingAdded = true;
      if (attachments.length) {
        const ok = await this.injectImages(msg.workspaceRoot, msg.prompt, attachments);
        if (!ok) {
          this.deps.removePending?.(msg.runId);
          this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "IMAGE_PASTE_FAILED" });
          return;
        }
      } else {
        const inj = await this.injectPrompt(msg.workspaceRoot, msg.prompt, 1500);
        if (!inj.submitted) {
          this.deps.removePending?.(msg.runId);
          this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: inj.reason ?? "INJECT_FAILED" });
          return;
        }
      }
      this.deps.onInjected?.(msg.runId);
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "accepted" });
    } catch (e) {
      if (pendingAdded) this.deps.removePending?.(msg.runId);
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: `INJECT_FAILED:${String(e)}` });
    } finally {
      lock.release();
    }
  }

  private async injectImages(
    workspaceRoot: string,
    prompt: string,
    attachments: { id?: string; sha256?: string; mime?: string }[],
  ): Promise<boolean> {
    if (!this.deps.fetchBlob || !this.deps.autoSubmitImages || !this.deps.writeClipboard) return false;
    const steps: { bytes: Buffer; mime: string }[] = [];
    for (const a of attachments) {
      const id = a.sha256 || a.id;
      if (!id) return false;
      const blob = await this.deps.fetchBlob(id);
      steps.push({ bytes: blob.bytes, mime: blob.mime || a.mime || "image/png" });
    }
    try {
      return await this.deps.autoSubmitImages(workspaceRoot, prompt, steps, this.deps.autoEnter !== false);
    } catch {
      return false;
    }
  }
  private async injectPrompt(
    workspaceRoot: string,
    prompt: string,
    pasteWaitMs: number,
  ): Promise<{ submitted: boolean; reason?: string }> {
    const vscode = vs();
    if (this.deps.autoSubmit) {
      try {
        const first = autoSubmitOutcome(await this.deps.autoSubmit(workspaceRoot, prompt));
        if (first.ok) return { submitted: true };
        if (isDirtyComposer(first.reason)) return { submitted: false, reason: "NON_EMPTY_INPUT" };
      } catch {
        // CDP threw; clipboard fallback below
      }
    }
    await this.sleep(pasteWaitMs);
    await vscode.env.clipboard.writeText(prompt);
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    if (this.deps.autoSubmit) {
      try {
        const second = autoSubmitOutcome(await this.deps.autoSubmit(workspaceRoot, prompt));
        if (second.ok) return { submitted: true };
        if (isDirtyComposer(second.reason)) return { submitted: false, reason: "NON_EMPTY_INPUT" };
      } catch {
        return { submitted: false, reason: "INJECT_FAILED" };
      }
    }
    return { submitted: true };
  }

  async cancel(conversationId: string): Promise<void> {
    try {
      await vs().commands.executeCommand("composer.cancelChat", conversationId);
    } catch (e) {
      console.error(`[armada] cancelChat failed cid=${conversationId}`, e);
    }
  }

  async followup(msg: {
    runId: string;
    conversationId: string;
    prompt: string;
    workspaceRoot: string;
    attachments?: { id?: string; sha256?: string; mime?: string }[];
  }): Promise<void> {
    const vscode = vs();
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (attachments.length && this.deps.imagePaste === false) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "IMAGE_PASTE_DISABLED" });
      return;
    }
    const lock = await acquireCdpLock({
      lockPath: this.deps.cdpLockPath ?? join(homedir(), ".cursor", "armada", "cdp.lock"),
      timeoutMs: 25_000,
      sleep: this.sleep,
    });
    if (!lock.ok) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "CDP_LOCK_TIMEOUT" });
      return;
    }
    try {
      await vscode.commands.executeCommand("composer.openComposer", msg.conversationId);
      if (attachments.length) {
        const ok = await this.injectImages(msg.workspaceRoot, msg.prompt, attachments);
        if (!ok) {
          this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "IMAGE_PASTE_FAILED" });
          return;
        }
      } else {
        const inj = await this.injectPrompt(msg.workspaceRoot, msg.prompt, 800);
        if (!inj.submitted) {
          this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: inj.reason ?? "INJECT_FAILED" });
          return;
        }
      }
      this.deps.onInjected?.(msg.runId);
      this.deps.addPending?.({
        runId: msg.runId,
        workspaceRoot: msg.workspaceRoot,
        prompt: msg.prompt,
        dispatchedAt: Date.now(),
        attachmentIds: attachments.map((a) => a.sha256 || a.id).filter((x): x is string => !!x),
      });
      this.deps.bindKnown?.({
        runId: msg.runId,
        conversationId: msg.conversationId,
        prompt: msg.prompt,
        workspaceRoot: msg.workspaceRoot,
      });
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "accepted" });
    } catch (e) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: `FOLLOWUP_FAILED:${String(e)}` });
    } finally {
      lock.release();
    }
  }

  async answerAsk(msg: {
    runId: string;
    conversationId: string;
    workspaceRoot: string;
    request_id: string;
    action: "continue" | "skip";
    answers?: { question_id: string; option_ids: string[] }[];
  }): Promise<void> {
    const vscode = vs();
    const lock = await acquireCdpLock({
      lockPath: this.deps.cdpLockPath ?? join(homedir(), ".cursor", "armada", "cdp.lock"),
      timeoutMs: 25_000,
      sleep: this.sleep,
    });
    if (!lock.ok) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "CDP_LOCK_TIMEOUT" });
      return;
    }
    try {
      await vscode.commands.executeCommand("composer.openComposer", msg.conversationId);
      const letter = msg.action === "continue" ? msg.answers?.[0]?.option_ids?.[0] : undefined;
      if (msg.action === "continue" && !letter) {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "ASK_INVALID_OPTION" });
        return;
      }
      if (!this.deps.answerAskCdp) {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "ASK_WIDGET_NOT_FOUND" });
        return;
      }
      const r = await this.deps.answerAskCdp({
        workspaceRoot: msg.workspaceRoot,
        action: msg.action,
        letter,
      });
      if (!r.ok) {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: r.reason ?? "ASK_SUBMIT_FAILED" });
        return;
      }
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "accepted" });
    } catch (e) {
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: `ASK_SUBMIT_FAILED:${String(e)}` });
    } finally {
      lock.release();
    }
  }
}
