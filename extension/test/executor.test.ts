import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const clipboardWrites: string[] = [];
const commands: string[] = [];
const commandArgs: unknown[][] = [];
const spawned: { cmd: string; args: string[] }[] = [];
let workspaceFolderPaths = ["/ws/a"];

mock.module("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return workspaceFolderPaths.map((fsPath) => ({ uri: { fsPath } }));
    },
  },
  window: { showInformationMessage: async () => "允许" },
  commands: { executeCommand: async (cmd: string, ...args: unknown[]) => { commands.push(cmd); commandArgs.push(args); } },
  env: { clipboard: { writeText: async (t: string) => { clipboardWrites.push(t); } } },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: "file" }) },
}));

import { CancelWatcher, Executor } from "../src/executor";

function makeExec(over: Partial<ConstructorParameters<typeof Executor>[0]> = {}) {
  clipboardWrites.length = 0;
  commands.length = 0;
  commandArgs.length = 0;
  spawned.length = 0;
  workspaceFolderPaths = ["/ws/a"];
  const acks: Record<string, unknown>[] = [];
  const lockPath = join(mkdtempSync(join(tmpdir(), "armada-exec-")), "cdp.lock");
  const armadaHome = mkdtempSync(join(tmpdir(), "armada-home-"));
  const ex = new Executor({
    globalState: {
      get: (_k, d) => (d !== undefined ? ["/ws/a"] : ["/ws/a"]) as never,
      update: async () => {},
    },
    send: (m) => { acks.push(m as Record<string, unknown>); },
    sleep: async () => {},
    cdpLockPath: lockPath,
    armadaHome,
    cursorBin: () => "/bin/cursor",
    spawnDetached: (cmd, args) => { spawned.push({ cmd, args }); },
    ...over,
  });
  return { ex, acks };
}

const pngAtt = [{ sha256: "abc", mime: "image/png", id: "abc" }];

describe("Executor image path", () => {
  test("imagePaste=false with attachments rejects IMAGE_PASTE_DISABLED before newAgentChat", async () => {
    const { ex, acks } = makeExec({ imagePaste: false });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: pngAtt });
    expect(acks).toEqual([{ type: "run.ack", runId: "r1", status: "rejected", reason: "IMAGE_PASTE_DISABLED" }]);
    expect(commands).toEqual([]);
    expect(clipboardWrites).toEqual([]);
  });

  const txtAtt = [{ sha256: "def", mime: "text/plain", id: "def", name: "notes.txt" }];

  test("imagePaste=false with only files still injects", async () => {
    const { ex, acks } = makeExec({
      imagePaste: false,
      fetchBlob: async () => ({ bytes: Buffer.from("hi"), mime: "text/plain" }),
      autoSubmitFileMentions: async () => true,
      finishComposer: async () => true,
      materializeFile: () => ({ needle: "def-notes.txt" }),
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: txtAtt });
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
    expect(commands).toContain("composer.createNew");
  });

  test("file mention failure rejects FILE_MENTION_FAILED", async () => {
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("hi"), mime: "text/plain" }),
      autoSubmitFileMentions: async () => false,
      finishComposer: async () => true,
      materializeFile: () => ({ needle: "def-notes.txt" }),
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: txtAtt });
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "rejected", reason: "FILE_MENTION_FAILED" });
  });

  test("image paste uses autoSubmitImages without a separate writeClipboard", async () => {
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("x"), mime: "image/png" }),
      autoSubmitImages: async () => true,
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: pngAtt });
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });

  test("injectImages failure does not writeText and does not accepted", async () => {
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("x"), mime: "image/png" }),
      autoSubmitImages: async () => false,
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: pngAtt });
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "rejected", reason: "IMAGE_PASTE_FAILED" });
    expect(clipboardWrites).toEqual([]);
  });

  test("autoSubmitImages CHIP_COUNT is not rewritten to IMAGE_PASTE_FAILED", async () => {
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("x"), mime: "image/png" }),
      autoSubmitImages: async () => ({ ok: false, reason: "CHIP_COUNT:1" }),
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: pngAtt });
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "CHIP_COUNT:1",
    });
  });

  test("autoSubmitImages CLIPBOARD_TIMEOUT is not rewritten to IMAGE_PASTE_FAILED", async () => {
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("x"), mime: "image/png" }),
      autoSubmitImages: async () => { throw new Error("CLIPBOARD_TIMEOUT"); },
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: pngAtt });
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "CLIPBOARD_TIMEOUT",
    });
  });

  test("autoSubmitImages WINDOW_TARGET_NOT_FOUND is not rewritten to IMAGE_PASTE_FAILED", async () => {
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("x"), mime: "image/png" }),
      autoSubmitImages: async () => ({ ok: false, reason: "WINDOW_TARGET_NOT_FOUND" }),
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: pngAtt });
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "WINDOW_TARGET_NOT_FOUND",
    });
    expect(clipboardWrites).toEqual([]);
  });

  test("file mention WINDOW_TARGET_AMBIGUOUS is not rewritten to FILE_MENTION_FAILED", async () => {
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("hi"), mime: "text/plain" }),
      autoSubmitFileMentions: async () => ({ ok: false, reason: "WINDOW_TARGET_AMBIGUOUS" }),
      finishComposer: async () => true,
      materializeFile: () => ({ needle: "def-notes.txt" }),
    });
    await ex.startRun({
      runId: "r1", workspaceRoot: "/ws/a", prompt: "see",
      attachments: [{ sha256: "def", mime: "text/plain", id: "def", name: "notes.txt" }],
    });
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "WINDOW_TARGET_AMBIGUOUS",
    });
    expect(clipboardWrites).toEqual([]);
  });

  test("followup IMAGE_PASTE_FAILED does not bindKnown", async () => {
    let bound = 0;
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("x"), mime: "image/png" }),
      autoSubmitImages: async () => false,
      bindKnown: () => { bound += 1; },
    });
    await ex.followup({
      runId: "r1", conversationId: "c1", prompt: "see", workspaceRoot: "/ws/a", attachments: pngAtt,
    });
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "rejected", reason: "IMAGE_PASTE_FAILED" });
    expect(bound).toBe(0);
    expect(clipboardWrites).toEqual([]);
  });

  test("text path still writeText when CDP autoSubmit is off", async () => {
    const { ex, acks } = makeExec({});
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "hello" });
    expect(clipboardWrites).toEqual(["hello"]);
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });

  // 2026-09-08 真机 Armada.log: cdp submit failed: NON_EMPTY_INPUT:windows-packaging-self-hosted-
  // composer.newAgentChat 会把当前活动编辑器做成引用芯片；其前的 focusActiveEditorGroup 还会把焦点抢回该文件。
  test("startRun opens empty New Chat, not newAgentChat+focus editor", async () => {
    const { ex } = makeExec({});
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "帮我确认一下本地是否有安装最新的Finclaw" });
    expect(commands).toContain("composer.createNew");
    expect(commands).not.toContain("composer.newAgentChat");
    expect(commands).not.toContain("workbench.action.focusActiveEditorGroup");
  });

  test("image startRun sends run.progress before paste finishes and addPending after paste", async () => {
    const order: string[] = [];
    let finishPaste: (ok: boolean) => void = () => {};
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("x"), mime: "image/png" }),
      addPending: () => { order.push("pending"); },
      autoSubmitImages: () => new Promise<boolean>((resolve) => {
        order.push("paste");
        finishPaste = resolve;
      }),
    });
    const done = ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: pngAtt });
    await new Promise((r) => setTimeout(r, 20));
    expect(acks.some((m) => m.type === "run.progress" && m.runId === "r1")).toBe(true);
    expect(acks.some((m) => m.type === "run.ack")).toBe(false);
    expect(order).toEqual(["paste"]);
    finishPaste(true);
    await done;
    expect(order).toEqual(["paste", "pending"]);
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });

  test("two attachment blobs start fetching before either finishes", async () => {
    let started = 0;
    const gates: Array<() => void> = [];
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: () => new Promise<{ bytes: Buffer; mime: string }>((resolve) => {
        started += 1;
        gates.push(() => resolve({ bytes: Buffer.from("x"), mime: "image/png" }));
      }),
      autoSubmitImages: async () => true,
    });
    const done = ex.startRun({
      runId: "r1", workspaceRoot: "/ws/a", prompt: "see",
      attachments: [
        { sha256: "a", mime: "image/png", id: "a" },
        { sha256: "b", mime: "image/png", id: "b" },
      ],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(2);
    for (const g of gates) g();
    await done;
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });
});

describe("Executor dirty composer", () => {
  test("NON_EMPTY_INPUT does not clipboard-paste and rejects startRun", async () => {
    let added = 0;
    let removed = 0;
    const { ex, acks } = makeExec({
      autoSubmit: async () => ({ ok: false, reason: "NON_EMPTY_INPUT:bun (986-1016)" }),
      addPending: () => { added += 1; },
      removePending: () => { removed += 1; },
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "hello" });
    expect(clipboardWrites).toEqual([]);
    expect(added).toBe(0);
    expect(removed).toBe(0);
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "NON_EMPTY_INPUT",
    });
  });

  test("NON_EMPTY_INPUT followup does not bindKnown or clipboard", async () => {
    let bound = 0;
    const { ex, acks } = makeExec({
      autoSubmit: async () => ({ ok: false, reason: "NON_EMPTY_INPUT:bun (986-1016)" }),
      bindKnown: () => { bound += 1; },
    });
    await ex.followup({
      runId: "r1", conversationId: "c1", prompt: "hello", workspaceRoot: "/ws/a",
    });
    expect(clipboardWrites).toEqual([]);
    expect(bound).toBe(0);
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "NON_EMPTY_INPUT",
    });
  });

  test("VERIFY_FAIL does not clipboard-paste and rejects startRun", async () => {
    const { ex, acks } = makeExec({
      autoSubmit: async () => ({ ok: false, reason: "VERIFY_FAIL:MISMATCH:garbage" }),
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "hello" });
    expect(clipboardWrites).toEqual([]);
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "VERIFY_FAIL:MISMATCH:garbage",
    });
  });

  test("followup reclaims last submitted prompt; new startRun does not", async () => {
    const seen: { prompt: string; reclaim?: string[] }[] = [];
    const { ex } = makeExec({
      autoSubmit: async (_ws, prompt, opts) => {
        seen.push({ prompt, reclaim: opts?.reclaim });
        return { ok: true };
      },
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "首轮原文" });
    await ex.followup({
      runId: "r1", conversationId: "c1", prompt: "续发", workspaceRoot: "/ws/a",
    });
    await ex.startRun({ runId: "r2", workspaceRoot: "/ws/a", prompt: "新任务" });
    expect(seen[1]?.prompt).toBe("续发");
    expect(seen[1]?.reclaim).toContain("首轮原文");
    expect(seen[2]?.prompt).toBe("新任务");
    expect(seen[2]?.reclaim ?? []).not.toContain("首轮原文");
  });

  test("VERIFY_FAIL leftover is reclaimed on the next startRun", async () => {
    const seen: { prompt: string; reclaim?: string[] }[] = [];
    let n = 0;
    const { ex } = makeExec({
      autoSubmit: async (_ws, prompt, opts) => {
        seen.push({ prompt, reclaim: opts?.reclaim });
        n += 1;
        if (n === 1) return { ok: false, reason: "VERIFY_FAIL:MISMATCH:x" };
        return { ok: true };
      },
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "半成功" });
    await ex.startRun({ runId: "r2", workspaceRoot: "/ws/a", prompt: "下一枪" });
    expect(seen[1]?.reclaim).toContain("半成功");
  });

  test("live followup does not bindKnown or addPending (E1)", async () => {
    let bound = 0;
    let added = 0;
    const { ex, acks } = makeExec({
      autoSubmit: async () => ({ ok: true }),
      bindKnown: () => { bound += 1; },
      addPending: () => { added += 1; },
    });
    await ex.followup({
      runId: "r1", conversationId: "c1", prompt: "hello", workspaceRoot: "/ws/a", live: true,
    });
    expect(bound).toBe(0);
    expect(added).toBe(0);
    expect(commands).toContain("composer.openComposer");
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });

  test("openWorkspaceWindow duplicates current workspace instead of openFolder same path", async () => {
    const { ex } = makeExec();
    await ex.openWorkspaceWindow("/ws/a");
    expect(commands).toEqual(["workbench.action.duplicateWorkspaceInNewWindow"]);
    expect(commandArgs[0] ?? []).toEqual([]);
  });

  test("openWorkspaceWindow duplicates Windows same folder despite slash and drive case", async () => {
    workspaceFolderPaths = ["c:\\Users\\PC\\Desktop\\work"];
    const { ex } = makeExec();
    workspaceFolderPaths = ["c:\\Users\\PC\\Desktop\\work"];
    await ex.openWorkspaceWindow("C:/Users/PC/Desktop/work");
    expect(commands).toEqual(["workbench.action.duplicateWorkspaceInNewWindow"]);
  });

  test("openWorkspaceWindow uses vscode.openFolder forceNewWindow for a different folder", async () => {
    const { ex } = makeExec({ cursorBin: () => null });
    await ex.openWorkspaceWindow("/ws/b");
    expect(commands).toEqual(["vscode.openFolder"]);
    expect(commandArgs[0]?.[0]).toEqual({ fsPath: "/ws/b", scheme: "file" });
    expect(commandArgs[0]?.[1]).toEqual({ forceNewWindow: true });
  });

  test("openWorkspaceWindow opens a folder-named .code-workspace via cursor --new-window", async () => {
    const { ex } = makeExec();
    await ex.openWorkspaceWindow("/Users/apple/Desktop/desk");
    expect(commands).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.cmd).toBe("/bin/cursor");
    expect(spawned[0]?.args[0]).toBe("--new-window");
    const file = spawned[0]?.args[1] ?? "";
    expect(file.endsWith("/open-windows/desk.code-workspace")).toBe(true);
    const body = JSON.parse(await Bun.file(file).text()) as { folders: { path: string }[] };
    expect(body.folders[0]?.path).toBe("/Users/apple/Desktop/desk");
  });

  test("CDP_UNREACHABLE rejects startRun without createNew or clipboard", async () => {
    let n = 0;
    const { ex, acks } = makeExec({
      probeCdp: async () => ({ ok: false, reason: "CDP_UNREACHABLE" }),
      autoSubmit: async () => {
        n += 1;
        return { ok: false, reason: "CDP_UNREACHABLE" };
      },
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "hello" });
    expect(clipboardWrites).toEqual([]);
    expect(n).toBe(0);
    expect(commands).not.toContain("composer.createNew");
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "CDP_UNREACHABLE",
    });
  });

  test("CDP_UNREACHABLE followup does not openComposer", async () => {
    const { ex, acks } = makeExec({
      probeCdp: async () => ({ ok: false, reason: "CDP_UNREACHABLE" }),
      autoSubmit: async () => ({ ok: false, reason: "CDP_UNREACHABLE" }),
    });
    await ex.followup({
      runId: "r1", conversationId: "c1", prompt: "hello", workspaceRoot: "/ws/a",
    });
    expect(clipboardWrites).toEqual([]);
    expect(commands).not.toContain("composer.openComposer");
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "CDP_UNREACHABLE",
    });
  });

  // 2026-09-18 Win Destop: logo.png - work - Cursor → WINDOW_TARGET_NOT_FOUND
  // 两次 cdp submit failed 后仍 run.ack accepted（剪贴板假成功）。
  test("WINDOW_TARGET_NOT_FOUND rejects startRun without clipboard fake accepted", async () => {
    const { ex, acks } = makeExec({
      autoSubmit: async () => ({ ok: false, reason: "WINDOW_TARGET_NOT_FOUND" }),
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "hello" });
    expect(clipboardWrites).toEqual([]);
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "WINDOW_TARGET_NOT_FOUND",
    });
  });

  test("WINDOW_TARGET_AMBIGUOUS rejects followup without clipboard", async () => {
    const { ex, acks } = makeExec({
      autoSubmit: async () => ({ ok: false, reason: "WINDOW_TARGET_AMBIGUOUS" }),
    });
    await ex.followup({
      runId: "r1", conversationId: "c1", prompt: "hello", workspaceRoot: "/ws/a",
    });
    expect(clipboardWrites).toEqual([]);
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "WINDOW_TARGET_AMBIGUOUS",
    });
  });
});

describe("Executor answerAsk", () => {
  test("does not writeText or autoSubmit; opens composer and uses CDP path", async () => {
    let cdp = 0;
    const auto: string[] = [];
    const { ex, acks } = makeExec({
      autoSubmit: async (ws, prompt) => { auto.push(`${ws}:${prompt}`); return true; },
      answerAskCdp: async () => { cdp += 1; return { ok: true }; },
    });
    await ex.answerAsk({
      runId: "r1", conversationId: "c1", workspaceRoot: "/ws/a",
      request_id: "ask-1", action: "continue", answers: [{ question_id: "q0", option_ids: ["b"] }],
    });
    expect(clipboardWrites).toEqual([]);
    expect(auto).toEqual([]);
    expect(cdp).toBe(1);
    expect(commands).toContain("composer.openComposer");
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });

  test("CDP_UNREACHABLE answerAsk does not openComposer", async () => {
    let cdp = 0;
    const { ex, acks } = makeExec({
      probeCdp: async () => ({ ok: false, reason: "CDP_UNREACHABLE" }),
      answerAskCdp: async () => { cdp += 1; return { ok: true }; },
    });
    await ex.answerAsk({
      runId: "r1", conversationId: "c1", workspaceRoot: "/ws/a",
      request_id: "ask-1", action: "skip",
    });
    expect(cdp).toBe(0);
    expect(commands).not.toContain("composer.openComposer");
    expect(acks[acks.length - 1]).toEqual({
      type: "run.ack", runId: "r1", status: "rejected", reason: "CDP_UNREACHABLE",
    });
  });

  test("skip does not require a letter", async () => {
    const { ex, acks } = makeExec({
      answerAskCdp: async (a) => {
        expect(a.action).toBe("skip");
        return { ok: true };
      },
    });
    await ex.answerAsk({
      runId: "r1", conversationId: "c1", workspaceRoot: "/ws/a",
      request_id: "ask-1", action: "skip",
    });
    expect(clipboardWrites).toEqual([]);
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });

  test("passes kind=plan through to the CDP driver", async () => {
    let seen: { kind?: string; letter?: string } | undefined;
    const { ex, acks } = makeExec({
      answerAskCdp: async (a) => {
        seen = { kind: a.kind, letter: a.letter };
        return { ok: true };
      },
    });
    await ex.answerAsk({
      runId: "r1", conversationId: "c1", workspaceRoot: "/ws/a",
      request_id: "ask-plan-1", action: "continue", kind: "plan",
      answers: [{ question_id: "q0", option_ids: ["build"] }],
    });
    expect(seen).toEqual({ kind: "plan", letter: "build" });
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });

  test("freeform passes text and does not require a letter", async () => {
    let seen: { action?: string; letter?: string; text?: string } | undefined;
    const { ex, acks } = makeExec({
      answerAskCdp: async (a) => {
        seen = { action: a.action, letter: a.letter, text: a.text };
        return { ok: true };
      },
    });
    await ex.answerAsk({
      runId: "r1", conversationId: "c1", workspaceRoot: "/ws/a",
      request_id: "ask-1", action: "freeform", text: "走平台合同", answers: [],
    });
    expect(seen).toEqual({ action: "freeform", letter: undefined, text: "走平台合同" });
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });

  test("option id build without kind is not treated as plan", async () => {
    let seen: { kind?: string; letter?: string } | undefined;
    const { ex, acks } = makeExec({
      answerAskCdp: async (a) => {
        seen = { kind: a.kind, letter: a.letter };
        return { ok: true };
      },
    });
    await ex.answerAsk({
      runId: "r1", conversationId: "c1", workspaceRoot: "/ws/a",
      request_id: "ask-1", action: "continue",
      answers: [{ question_id: "q0", option_ids: ["build"] }],
    });
    expect(seen).toEqual({ kind: undefined, letter: "build" });
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "accepted" });
  });
});

function bsp(cid: string, generationId: string, prompt = "hello") {
  return { hook: "beforeSubmitPrompt", raw: { conversation_id: cid, generation_id: generationId, prompt } };
}

describe("CancelWatcher injection identity", () => {
  test("late injection BSP re-cancels even when prompt differs", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "g-live", 100_000);
    w.noteInjection("r1");
    expect(w.shouldCancelAgain(bsp("cid-1", "g-new", "totally different"), 101_600)).toBe("cid-1");
  });

  test("expected-next BSP still re-cancels after the old 5s inject window", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", undefined, 100_000);
    w.noteInjection("r1");
    expect(w.shouldCancelAgain(bsp("cid-1", "g-late"), 106_000)).toBe("cid-1");
  });

  test("BSP matching cancel-time live gen re-cancels without noteInjection", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "g-live", 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-live", "anything"), 101_000)).toBe("cid-1");
  });

  test("delayed live-gen BSP does not consume the expected-next injection slot", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "g-live", 100_000);
    w.noteInjection("r1");
    expect(w.shouldCancelAgain(bsp("cid-1", "g-live"), 101_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(bsp("cid-1", "g-new", "changed"), 101_500)).toBe("cid-1");
  });

  test("same prompt with a new gen is not ours after expected slot is consumed", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1");
    w.record("r1", "cid-1", "g-old", 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-ours", "hello"), 100_500)).toBe("cid-1");
    expect(w.shouldCancelAgain(bsp("cid-1", "g-human", "hello"), 101_000)).toBeNull();
  });

  test("new gen without expected slot or live match is not re-cancelled", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "g-live", 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-other", "hello"), 101_000)).toBeNull();
  });

  test("explicit expected BSP generation matches that gen only", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1", "g-hub");
    w.record("r1", "cid-1", "g-old", 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-other"), 101_000)).toBeNull();
    expect(w.shouldCancelAgain(bsp("cid-1", "g-hub", "changed"), 101_000)).toBe("cid-1");
  });

  test("same identity re-cancels at most twice", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1", "g-hub");
    w.record("r1", "cid-1", undefined, 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-hub"), 101_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(bsp("cid-1", "g-hub"), 102_000)).toBe("cid-1");
    expect(w.shouldCancelAgain(bsp("cid-1", "g-hub"), 103_000)).toBeNull();
  });

  test("after 20s cancel record window → no re-cancel", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1");
    w.record("r1", "cid-1", "g-live", 100_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-live"), 121_000)).toBeNull();
  });

  test("unrelated hook ignored even with matching gen", () => {
    const w = new CancelWatcher();
    w.record("r1", "cid-1", "g-live", 100_000);
    expect(w.shouldCancelAgain({
      hook: "preToolUse",
      raw: { conversation_id: "cid-1", generation_id: "g-live" },
    }, 101_000)).toBeNull();
  });

  test("BSP after inject fills identity so a later human BSP is not re-cancelled", () => {
    const w = new CancelWatcher();
    w.noteInjection("r1");
    w.noteBsp("r1", "g-ours");
    w.record("r1", "cid-1", "g-ours", 110_000);
    expect(w.shouldCancelAgain(bsp("cid-1", "g-human", "hello"), 111_000)).toBeNull();
  });
});
