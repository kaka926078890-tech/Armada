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
});
