import {
  applyIndexedChunk,
  MAX_OPERATOR_BODY,
  type IndexedChunkSession,
} from "./chunkUpload";

export type PromptChunkExtra = {
  workspaceId?: string;
  attachmentIds?: unknown;
};

export type PromptUploadSession = IndexedChunkSession<PromptChunkExtra>;

export type PromptChunkResult =
  | { error: string; status: number }
  | { pending: true }
  | { complete: string; extra: PromptChunkExtra };

const MAX_CHUNKS = Math.ceil(MAX_OPERATOR_BODY / 1024);

function extraFrom(raw: Record<string, unknown>): PromptChunkExtra {
  return {
    workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : undefined,
    attachmentIds: "attachmentIds" in raw ? raw.attachmentIds : undefined,
  };
}

export function applyPromptChunk(
  sessions: Map<string, PromptUploadSession>,
  token: string,
  body: unknown,
  now = Date.now(),
): PromptChunkResult {
  const stepped = applyIndexedChunk(sessions, token, body, {
    maxBytes: MAX_OPERATOR_BODY,
    maxChunks: MAX_CHUNKS,
    tooLargeError: "PAYLOAD_TOO_LARGE",
    tooLargeStatus: 413,
    extra: extraFrom,
    mergeExtra: (prev, next) => ({
      workspaceId: prev.workspaceId ?? next.workspaceId,
      attachmentIds: prev.attachmentIds !== undefined ? prev.attachmentIds : next.attachmentIds,
    }),
  }, now);
  if ("error" in stepped || "pending" in stepped) return stepped;
  return { complete: stepped.complete.toString("utf8"), extra: stepped.extra };
}

export function isPromptChunkBody(body: unknown): boolean {
  return !!body && typeof body === "object" && !Array.isArray(body)
    && typeof (body as { uploadId?: unknown }).uploadId === "string";
}
