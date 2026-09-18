import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const clipboardWrites: string[] = [];
const commands: string[] = [];

mock.module("vscode", () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: "/ws/a" } }] },
  window: { showInformationMessage: async () => "允许" },
  commands: { executeCommand: async (cmd: string) => { commands.push(cmd); } },
  env: { clipboard: { writeText: async (t: string) => { clipboardWrites.push(t); } } },
}));

import { Executor } from "../src/executor";

function makeExec(over: Partial<ConstructorParameters<typeof Executor>[0]> = {}) {
  clipboardWrites.length = 0;
  commands.length = 0;
  const acks: Record<string, unknown>[] = [];
  const lockPath = join(mkdtempSync(join(tmpdir(), "armada-exec-")), "cdp.lock");
  const ex = new Executor({
    globalState: {
      get: (_k, d) => (d !== undefined ? ["/ws/a"] : ["/ws/a"]) as never,
      update: async () => {},
    },
    send: (m) => { acks.push(m as Record<string, unknown>); },
    sleep: async () => {},
    cdpLockPath: lockPath,
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

  test("injectImages failure does not writeText and does not accepted", async () => {
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("x"), mime: "image/png" }),
      writeClipboard: () => {},
      autoSubmitImages: async () => false,
    });
    await ex.startRun({ runId: "r1", workspaceRoot: "/ws/a", prompt: "see", attachments: pngAtt });
    expect(acks[acks.length - 1]).toEqual({ type: "run.ack", runId: "r1", status: "rejected", reason: "IMAGE_PASTE_FAILED" });
    expect(clipboardWrites).toEqual([]);
  });

  test("followup IMAGE_PASTE_FAILED does not bindKnown", async () => {
    let bound = 0;
    const { ex, acks } = makeExec({
      imagePaste: true,
      fetchBlob: async () => ({ bytes: Buffer.from("x"), mime: "image/png" }),
      writeClipboard: () => {},
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
      writeClipboard: () => {},
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
      writeClipboard: () => {},
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
});
