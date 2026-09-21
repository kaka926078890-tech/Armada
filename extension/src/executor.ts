import { homedir } from "os";
import { join } from "path";
import type { PendingRun } from "./binding";
import { acquireCdpLock } from "./cdpLock";
import { workspacePathIn } from "./workspacePath";
import { materializeInboxFile, uniqueInboxFilename } from "./workspaceInbox";

const CANCEL_RECORD_WINDOW_MS = 20_000;

export class CancelWatcher {
  private records = new Map<string, { cid: string; liveGen?: string; at: number; count: number }>();
  /** Our Enter has no UUID yet: the next owner BSP for this run is the injection. */
  private expectNext = new Set<string>();
  /** Hub-issued gen, or the UUID filled from that next BSP. */
  private expectedGen = new Map<string, string>();

  /** Called by Executor right after our own submit lands (CDP enter or clipboard paste). */
  noteInjection(runId: string, expectedGenerationId?: string): void {
    if (typeof expectedGenerationId === "string" && expectedGenerationId) {
      this.expectedGen.set(runId, expectedGenerationId);
      this.expectNext.delete(runId);
      return;
    }
    this.expectNext.add(runId);
  }

  /** Owner BSP landed for this run. Fills the expected-next slot even if cancel has not been recorded yet. */
  noteBsp(runId: string, generationId: string): void {
    if (!generationId || this.expectedGen.has(runId) || !this.expectNext.has(runId)) return;
    this.expectedGen.set(runId, generationId);
    this.expectNext.delete(runId);
  }

  record(runId: string, conversationId: string, liveGenerationId: string | undefined, nowMs: number): void {
    this.records.set(runId, {
      cid: conversationId,
      liveGen: liveGenerationId || undefined,
      at: nowMs,
      count: 0,
    });
  }

  shouldCancelAgain(ev: { hook: string; raw: any }, nowMs: number): string | null {
    if (ev.hook !== "beforeSubmitPrompt") return null;
    const cid = ev.raw?.conversation_id;
    const gen = typeof ev.raw?.generation_id === "string" ? ev.raw.generation_id : "";
    for (const [runId, r] of this.records) {
      if (cid !== r.cid) continue;
      if (nowMs - r.at > CANCEL_RECORD_WINDOW_MS) {
        this.records.delete(runId);
        this.expectNext.delete(runId);
        this.expectedGen.delete(runId);
        continue;
      }
      const known = this.expectedGen.get(runId);
      const waiting = this.expectNext.has(runId);
      const matchLive = !!(r.liveGen && gen === r.liveGen);
      const matchExpected = !!(gen && ((known && gen === known) || (waiting && !matchLive)));
      if (!matchExpected && !matchLive) continue;
      if (waiting && gen && !matchLive) {
        this.expectedGen.set(runId, gen);
        this.expectNext.delete(runId);
      }
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
  /** Called after inject succeeds — binding window starts here. */
  addPending?: (run: PendingRun) => void;
  /** Drop a pending entry on INJECT_FAILED after it was already added. */
  removePending?: (runId: string) => void;
  /** Our own submit landed. Next owner BSP (or this hub gen) is the injection identity. */
  onInjected?: (runId: string) => void;
  /**
   * 注入前探 9222。不通则禁止 createNew / openComposer，也不能用剪贴板冒充已发送。
   */
  probeCdp?: () => Promise<{ ok: boolean; reason?: string }>;
  /**
   * 全自动提交(CDP DOM 注入)。true / `{ ok:true }` 表示已写入并回车。
   * `NON_EMPTY_INPUT*`：框里是别人的草稿/引用芯片，禁止剪贴板往里贴。
   * `CDP_UNREACHABLE` / `CDP_CONNECT_FAIL*`：口不通，禁止剪贴板假 ack。
   * `WINDOW_TARGET_*` / `NO_WS_URL`：口通但选不中工作区页，同样禁止剪贴板假 ack。
   * `reclaim`：Armada 自己留下的原文(取消回灌 / 上次写入未提交)，允许整框替换。
   */
  autoSubmit?: (
    workspaceRoot: string,
    prompt: string,
    opts?: { reclaim?: string[] },
  ) => Promise<boolean | { ok: boolean; reason?: string }>;
  imagePaste?: boolean;
  fetchBlob?: (id: string) => Promise<{ bytes: Buffer; mime: string }>;
  autoSubmitImages?: (
    workspaceRoot: string,
    prompt: string,
    steps: { bytes: Buffer; mime: string }[],
    autoSubmit: boolean,
  ) => Promise<boolean | { ok: boolean; reason?: string }>;
  autoSubmitFileMentions?: (
    workspaceRoot: string,
    needles: string[],
  ) => Promise<boolean | { ok: boolean; reason?: string }>;
  finishComposer?: (
    workspaceRoot: string,
    prompt: string,
    autoSubmit: boolean,
  ) => Promise<boolean | { ok: boolean; reason?: string }>;
  materializeFile?: (workspaceRoot: string, runId: string, name: string, bytes: Buffer) => { needle: string };
  autoEnter?: boolean;
  /**
   * Called when conversation_id is already known (followup) so we do not wait for hooks.
   */
  bindKnown?: (args: { runId: string; conversationId: string; prompt: string; workspaceRoot: string }) => void;
  /** Override path of the machine-wide CDP inject lock (tests / non-default home). */
  cdpLockPath?: string;
  answerAskCdp?: (args: {
    workspaceRoot: string;
    action: "continue" | "skip" | "freeform";
    letter?: string;
    kind?: "plan";
    text?: string;
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

function isCdpDown(reason?: string): boolean {
  return reason === "CDP_UNREACHABLE" || (typeof reason === "string" && reason.startsWith("CDP_CONNECT_FAIL"));
}

function isPasteDetail(reason?: string): boolean {
  return reason === "CLIPBOARD_TIMEOUT"
    || (typeof reason === "string" && reason.startsWith("CHIP_COUNT"));
}

/** 自动提交时这些失败不能降级成剪贴板 accepted。 */
function isCdpHardFail(reason?: string): boolean {
  return isCdpDown(reason)
    || reason === "WINDOW_TARGET_NOT_FOUND"
    || reason === "WINDOW_TARGET_AMBIGUOUS"
    || reason === "NO_WS_URL"
    || isPasteDetail(reason);
}

export class Executor {
  private sleep: (ms: number) => Promise<void>;
  /** 上次成功提交的原文。取消后 Cursor 可能回灌到框里，仅 followup 可认领。 */
  private lastSubmittedPrompt: string | null = null;
  /** 上次 insertText 后校验/回车失败，框里可能仍是这句。start 与 followup 都可认领。 */
  private lastFailedWrite: string | null = null;
  constructor(private deps: ExecutorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private reclaimFor(kind: "start" | "followup"): string[] {
    const out: string[] = [];
    if (this.lastFailedWrite) out.push(this.lastFailedWrite);
    if (kind === "followup" && this.lastSubmittedPrompt) out.push(this.lastSubmittedPrompt);
    return out;
  }

  private noteInjectResult(prompt: string, submitted: boolean, reason?: string): void {
    if (submitted) {
      this.lastSubmittedPrompt = prompt;
      this.lastFailedWrite = null;
      return;
    }
    if (reason && (reason.startsWith("VERIFY_FAIL") || reason.startsWith("ENTER_FAIL"))) {
      this.lastFailedWrite = prompt;
    }
  }

  private authorizedWorkspaces(): string[] {
    return this.deps.globalState.get<string[]>("armada.authorizedWorkspaces", []) ?? [];
  }

  /** 首次派发没有空闲窗时：同工作区再开一扇 Cursor 窗，不在当前窗 createNew。 */
  async openWorkspaceWindow(workspaceRoot: string): Promise<void> {
    const root = String(workspaceRoot ?? "").trim();
    if (!root) return;
    const vscode = vs();
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), { forceNewWindow: true });
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
    if (attachments.some(isImageAtt) && this.deps.imagePaste === false) {
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
      const down = await this.cdpDownReason();
      if (down) {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: down });
        return;
      }
      // createNew = 空对话。newAgentChat 会把活动编辑器做成引用芯片（真机
      // NON_EMPTY_INPUT:windows-packaging-self-hosted-）；其前再 focus 编辑器组会把用户挪开的焦点抢回去。
      await vscode.commands.executeCommand("composer.createNew");
      this.noteProgress(msg.runId, "inject");
      if (attachments.length) {
        const inj = await this.injectAttachments(msg.runId, msg.workspaceRoot, msg.prompt, attachments);
        if (!inj.ok) {
          this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: inj.reason ?? "IMAGE_PASTE_FAILED" });
          return;
        }
      } else {
        const inj = await this.injectPrompt(msg.workspaceRoot, msg.prompt, 1500, this.reclaimFor("start"));
        this.noteInjectResult(msg.prompt, inj.submitted, inj.reason);
        if (!inj.submitted) {
          this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: inj.reason ?? "INJECT_FAILED" });
          return;
        }
      }
      // Binding window starts after inject so multi-image paste cannot expire the jsonl scan.
      this.deps.addPending?.({
        runId: msg.runId,
        workspaceRoot: msg.workspaceRoot,
        prompt: msg.prompt,
        dispatchedAt: Date.now(),
        attachmentIds: attachments.map((a) => a.sha256 || a.id).filter((x): x is string => !!x),
      });
      pendingAdded = true;
      this.deps.onInjected?.(msg.runId);
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "accepted" });
    } catch (e) {
      if (pendingAdded) this.deps.removePending?.(msg.runId);
      this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: `INJECT_FAILED:${String(e)}` });
    } finally {
      lock.release();
    }
  }

  private noteProgress(runId: string, phase: string): void {
    this.deps.send({ type: "run.progress", runId, phase });
  }

  private async cdpDownReason(): Promise<string | null> {
    if (!this.deps.probeCdp) return null;
    const r = await this.deps.probeCdp();
    if (r.ok) return null;
    return r.reason ?? "CDP_UNREACHABLE";
  }

  private async injectAttachments(
    runId: string,
    workspaceRoot: string,
    prompt: string,
    attachments: { id?: string; sha256?: string; mime?: string; name?: string }[],
  ): Promise<{ ok: boolean; reason?: string }> {
    const images = attachments.filter(isImageAtt);
    const files = attachments.filter((a) => !isImageAtt(a));
    try {
      if (images.length) {
        if (!this.deps.fetchBlob || !this.deps.autoSubmitImages) {
          return { ok: false, reason: "IMAGE_PASTE_FAILED" };
        }
        this.noteProgress(runId, "blobs");
        const steps = await Promise.all(images.map(async (a) => {
          const id = a.sha256 || a.id;
          if (!id) throw new Error("ATTACHMENT_ID");
          const blob = await this.deps.fetchBlob!(id);
          return { bytes: blob.bytes, mime: blob.mime || a.mime || "image/png" };
        }));
        const skipFinish = files.length > 0;
        this.noteProgress(runId, "paste");
        const img = autoSubmitOutcome(await this.deps.autoSubmitImages(
          workspaceRoot,
          skipFinish ? "" : prompt,
          steps,
          skipFinish ? false : this.deps.autoEnter !== false,
        ));
        if (!img.ok) {
          return { ok: false, reason: isCdpHardFail(img.reason) ? img.reason : "IMAGE_PASTE_FAILED" };
        }
      }
      if (files.length) {
        if (!this.deps.fetchBlob || !this.deps.autoSubmitFileMentions) {
          return { ok: false, reason: "FILE_MENTION_FAILED" };
        }
        this.noteProgress(runId, "blobs");
        const fetched = await Promise.all(files.map(async (a) => {
          const id = a.sha256 || a.id;
          if (!id) throw new Error("ATTACHMENT_ID");
          const blob = await this.deps.fetchBlob!(id);
          return { id, blob, name: a.name };
        }));
        const needles: string[] = [];
        const write = this.deps.materializeFile
          ?? ((ws: string, rid: string, filename: string, bytes: Buffer) => {
            materializeInboxFile(ws, rid, filename, bytes);
            return { needle: filename };
          });
        for (const item of fetched) {
          const name = uniqueInboxFilename(item.id, item.name || "file");
          needles.push(write(workspaceRoot, runId, name, item.blob.bytes).needle);
        }
        this.noteProgress(runId, "paste");
        const file = autoSubmitOutcome(await this.deps.autoSubmitFileMentions(workspaceRoot, needles));
        if (!file.ok) {
          return { ok: false, reason: isCdpHardFail(file.reason) ? file.reason : "FILE_MENTION_FAILED" };
        }
        if (!this.deps.finishComposer) return { ok: false, reason: "FILE_MENTION_FAILED" };
        const fin = autoSubmitOutcome(await this.deps.finishComposer(
          workspaceRoot, prompt, this.deps.autoEnter !== false,
        ));
        if (!fin.ok) {
          return { ok: false, reason: isCdpHardFail(fin.reason) ? fin.reason : "FILE_MENTION_FAILED" };
        }
      }
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "CLIPBOARD_TIMEOUT" || msg.endsWith("CLIPBOARD_TIMEOUT")) {
        return { ok: false, reason: "CLIPBOARD_TIMEOUT" };
      }
      return { ok: false, reason: files.length ? "FILE_MENTION_FAILED" : "IMAGE_PASTE_FAILED" };
    }
  }

  private async injectPrompt(
    workspaceRoot: string,
    prompt: string,
    pasteWaitMs: number,
    reclaim: string[] = [],
  ): Promise<{ submitted: boolean; reason?: string }> {
    const vscode = vs();
    if (this.deps.autoSubmit) {
      try {
        const first = autoSubmitOutcome(await this.deps.autoSubmit(workspaceRoot, prompt, { reclaim }));
        if (first.ok) return { submitted: true };
        if (isDirtyComposer(first.reason)) return { submitted: false, reason: "NON_EMPTY_INPUT" };
        if (isCdpHardFail(first.reason)) return { submitted: false, reason: first.reason ?? "CDP_UNREACHABLE" };
        return { submitted: false, reason: first.reason ?? "INJECT_FAILED" };
      } catch {
        return { submitted: false, reason: "INJECT_FAILED" };
      }
    }
    await this.sleep(pasteWaitMs);
    await vscode.env.clipboard.writeText(prompt);
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
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
    live?: boolean;
  }): Promise<void> {
    const vscode = vs();
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (attachments.some(isImageAtt) && this.deps.imagePaste === false) {
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
      const down = await this.cdpDownReason();
      if (down) {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: down });
        return;
      }
      this.noteProgress(msg.runId, "inject");
      await vscode.commands.executeCommand("composer.openComposer", msg.conversationId);
      if (attachments.length) {
        const inj = await this.injectAttachments(msg.runId, msg.workspaceRoot, msg.prompt, attachments);
        if (!inj.ok) {
          this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: inj.reason ?? "IMAGE_PASTE_FAILED" });
          return;
        }
      } else {
        const inj = await this.injectPrompt(msg.workspaceRoot, msg.prompt, 800, this.reclaimFor("followup"));
        this.noteInjectResult(msg.prompt, inj.submitted, inj.reason);
        if (!inj.submitted) {
          this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: inj.reason ?? "INJECT_FAILED" });
          return;
        }
      }
      this.deps.onInjected?.(msg.runId);
      if (!msg.live) {
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
      }
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
    action: "continue" | "skip" | "freeform";
    answers?: { question_id: string; option_ids: string[] }[];
    kind?: "plan";
    text?: string;
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
      const down = await this.cdpDownReason();
      if (down) {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: down });
        return;
      }
      await vscode.commands.executeCommand("composer.openComposer", msg.conversationId);
      const letter = msg.action === "continue" ? msg.answers?.[0]?.option_ids?.[0] : undefined;
      if (msg.action === "continue" && !letter) {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "ASK_INVALID_OPTION" });
        return;
      }
      if (msg.action === "freeform" && !String(msg.text ?? "").trim()) {
        this.deps.send({ type: "run.ack", runId: msg.runId, status: "rejected", reason: "ASK_TEXT_EMPTY" });
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
        text: msg.text,
        ...(msg.kind === "plan" ? { kind: "plan" as const } : {}),
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

function isImageAtt(a: { mime?: string }): boolean {
  return a.mime === "image/png" || a.mime === "image/jpeg";
}
