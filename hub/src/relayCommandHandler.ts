import { randomBytes } from "crypto";
import { decodeWorkspaceId } from "../../relay/src/uri";
import { MAX_BLOB_BYTES } from "./blobs";
import type { RunSnap } from "./relayClient";

export const RELAY_HEARTBEAT_MS = 25_000;

const B64_MAX_CHARS = Math.ceil(MAX_BLOB_BYTES * 4 / 3) + 64;

function cmdAttachmentIds(msg: any): string[] {
  return Array.isArray(msg?.attachmentIds) ? msg.attachmentIds.filter((x: unknown) => typeof x === "string") : [];
}

function encodeBlobPutBody(bytes: Buffer, mime: string, name: string): { body: Buffer; contentType: string } {
  const boundary = `----ArmadaBlob${randomBytes(12).toString("hex")}`;
  const filename = (name || "image.jpg").replace(/["\r\n\\]/g, "_");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime || "application/octet-stream"}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

export type RelayCommandDeps = {
  hubFetch: (path: string, init?: RequestInit) => Promise<Response>;
  snapOf: (runId: string) => Promise<RunSnap | null> | RunSnap | null;
  send: (msg: object) => void;
};

export function startRelayHeartbeat(ws: { ping: () => void }, ms = RELAY_HEARTBEAT_MS): () => void {
  const t = setInterval(() => {
    try { ws.ping(); } catch { /* ignore */ }
  }, ms);
  return () => clearInterval(t);
}

export function createRelayCommandHandler(deps: RelayCommandDeps): (msg: any) => Promise<void> {
  return async (msg: any) => {
    if (typeof msg?.type !== "string" || !msg.type.startsWith("cmd.")) return;
    const requestId = msg.requestId;
    const fail = (error: string) => deps.send({ type: "cmd.result", requestId, ok: false, error });
    const snapOf = async (runId: string) => await deps.snapOf(runId);
    try {
      if (msg.type === "cmd.cursorReloadGet") {
        const r = await deps.hubFetch("/api/cursor-reload");
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        deps.send({ type: "cmd.result", requestId, ok: true, cursorReload: body });
        return;
      }
      if (msg.type === "cmd.cursorReloadPost") {
        const r = await deps.hubFetch("/api/cursor-reload", {
          method: "POST",
          body: JSON.stringify({ action: msg.action, vsix: msg.vsix, notBefore: msg.notBefore, machineId: msg.machineId }),
        });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        deps.send({ type: "cmd.result", requestId, ok: true, cursorReload: body });
        return;
      }
      if (msg.type === "cmd.promptSnippetsGet") {
        const r = await deps.hubFetch("/api/prompt-snippets");
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        deps.send({ type: "cmd.result", requestId, ok: true, snippets: body.snippets ?? [] });
        return;
      }
      if (msg.type === "cmd.promptSnippetsPut") {
        const r = await deps.hubFetch("/api/prompt-snippets", {
          method: "PUT",
          body: JSON.stringify({ snippets: msg.snippets }),
        });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        deps.send({ type: "cmd.result", requestId, ok: true, snippets: body.snippets ?? [] });
        return;
      }
      if (msg.type === "cmd.blobPut") {
        const name = typeof msg.name === "string" ? msg.name : "";
        const mime = typeof msg.mime === "string" ? msg.mime : "";
        const b64 = msg.bytesBase64;
        if (typeof b64 !== "string" || !b64) return fail("INVALID");
        if (b64.length > B64_MAX_CHARS) return fail("ATTACHMENT_TOO_LARGE");
        const bytes = Buffer.from(b64, "base64");
        if (!bytes.length) return fail("INVALID");
        if (bytes.length > MAX_BLOB_BYTES) return fail("ATTACHMENT_TOO_LARGE");
        const packed = encodeBlobPutBody(bytes, mime, name);
        const r = await deps.hubFetch("/api/blobs", {
          method: "POST",
          headers: {
            "content-type": packed.contentType,
            "content-length": String(packed.body.length),
          },
          body: packed.body,
        });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        if (!body.blob?.id) return fail("HUB_ERROR");
        deps.send({ type: "cmd.result", requestId, ok: true, blob: body.blob });
        return;
      }
      if (msg.type === "cmd.dispatch") {
        const decoded = typeof msg.workspaceId === "string" ? decodeWorkspaceId(msg.workspaceId) : null;
        if (!decoded) return fail("INVALID");
        const attachmentIds = cmdAttachmentIds(msg);
        const payload: Record<string, unknown> = {
          machineId: decoded.machineId,
          workspaceRoot: decoded.workspaceRoot,
          prompt: msg.prompt ?? "",
        };
        if (attachmentIds.length) payload.attachmentIds = attachmentIds;
        const r = await deps.hubFetch("/api/runs", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        const run = await snapOf(body.run.id);
        deps.send({ type: "cmd.result", requestId, ok: true, run });
        if (run) deps.send({ type: "snap.run", run });
        return;
      }
      if (msg.type === "cmd.followup") {
        if (typeof msg.runId !== "string" || !msg.runId) return fail("INVALID");
        const attachmentIds = cmdAttachmentIds(msg);
        const payload: Record<string, unknown> = { prompt: msg.prompt ?? "" };
        if (attachmentIds.length) payload.attachmentIds = attachmentIds;
        const r = await deps.hubFetch(`/api/runs/${encodeURIComponent(msg.runId)}/followup`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        const run = await snapOf(msg.runId);
        deps.send({ type: "cmd.result", requestId, ok: true, run });
        if (run) deps.send({ type: "snap.run", run });
        return;
      }
      if (msg.type === "cmd.retry") {
        if (typeof msg.runId !== "string" || !msg.runId) return fail("INVALID");
        const r = await deps.hubFetch(`/api/runs/${encodeURIComponent(msg.runId)}/retry`, { method: "POST" });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        const run = await snapOf(msg.runId);
        deps.send({ type: "cmd.result", requestId, ok: true, run });
        if (run) deps.send({ type: "snap.run", run });
        return;
      }
      if (msg.type === "cmd.answer") {
        const r = await deps.hubFetch(`/api/runs/${encodeURIComponent(msg.runId)}/answer-ask`, {
          method: "POST",
          body: JSON.stringify(msg.body ?? {}),
        });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        const run = await snapOf(msg.runId);
        deps.send({ type: "cmd.result", requestId, ok: true, run });
        if (run) deps.send({ type: "snap.run", run });
        return;
      }
      if (msg.type === "cmd.cancel") {
        const r = await deps.hubFetch(`/api/runs/${encodeURIComponent(msg.runId)}/cancel`, { method: "POST" });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        const run = await snapOf(msg.runId);
        deps.send({ type: "cmd.result", requestId, ok: true, run });
        if (run) deps.send({ type: "snap.run", run });
        return;
      }
      if (msg.type === "cmd.archive" || msg.type === "cmd.unarchive") {
        if (typeof msg.runId !== "string" || !msg.runId) return fail("INVALID");
        const action = msg.type === "cmd.archive" ? "archive" : "unarchive";
        const r = await deps.hubFetch(`/api/runs/${encodeURIComponent(msg.runId)}/${action}`, { method: "POST" });
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        const run = await snapOf(msg.runId);
        deps.send({ type: "cmd.result", requestId, ok: true, run });
        if (run) deps.send({ type: "snap.run", run });
        return;
      }
      if (msg.type === "cmd.workspaceFileGet") {
        if (typeof msg.runId !== "string" || !msg.runId) return fail("INVALID");
        const path = typeof msg.path === "string" ? msg.path : "";
        const r = await deps.hubFetch(`/api/runs/${encodeURIComponent(msg.runId)}/file?path=${encodeURIComponent(path)}`);
        const body = await r.json().catch(() => ({})) as any;
        if (!r.ok) return fail(body.error ?? "HUB_ERROR");
        deps.send({
          type: "cmd.result",
          requestId,
          ok: true,
          file: { path: body.path, name: body.name, mime: body.mime, text: body.text },
        });
        return;
      }
      return fail("UNKNOWN_CMD");
    } catch {
      fail("HUB_ERROR");
    }
  };
}
