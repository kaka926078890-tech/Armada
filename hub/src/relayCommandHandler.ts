import { decodeWorkspaceId } from "../../relay/src/uri";
import type { RunSnap } from "./relayClient";

export const RELAY_HEARTBEAT_MS = 25_000;

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
      if (msg.type === "cmd.dispatch") {
        const decoded = typeof msg.workspaceId === "string" ? decodeWorkspaceId(msg.workspaceId) : null;
        if (!decoded) return fail("INVALID");
        const r = await deps.hubFetch("/api/runs", {
          method: "POST",
          body: JSON.stringify({ machineId: decoded.machineId, workspaceRoot: decoded.workspaceRoot, prompt: msg.prompt ?? "" }),
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
        const r = await deps.hubFetch(`/api/runs/${encodeURIComponent(msg.runId)}/followup`, {
          method: "POST",
          body: JSON.stringify({ prompt: msg.prompt ?? "" }),
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
      return fail("UNKNOWN_CMD");
    } catch {
      fail("HUB_ERROR");
    }
  };
}
