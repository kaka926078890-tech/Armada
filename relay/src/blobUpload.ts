import { MAX_BLOB_BYTES } from "../../hub/src/blobs";
import {
  applyIndexedChunk,
  CHUNK_UPLOAD_TTL_MS,
  sweepChunkUploads,
  WAF_JSON_CHUNK_BYTES,
  type IndexedChunkSession,
} from "./chunkUpload";

/** Public uuWAF in front of armada.finogeeks.club 500s HTML above ~10KiB. Keep JSON bodies under that. */
export const BLOB_UPLOAD_CHUNK_BYTES = WAF_JSON_CHUNK_BYTES;
export const BLOB_UPLOAD_TTL_MS = CHUNK_UPLOAD_TTL_MS;
const MAX_CHUNKS = Math.ceil(MAX_BLOB_BYTES / 1024);

export type BlobMeta = { name: string; mime: string };
export type BlobUploadSession = IndexedChunkSession<BlobMeta>;

export type BlobChunkResult =
  | { error: string; status: number }
  | { pending: true }
  | { complete: Buffer; name: string; mime: string };

export function sweepBlobUploads(sessions: Map<string, BlobUploadSession>, now = Date.now()): void {
  sweepChunkUploads(sessions, now);
}

export function applyBlobChunk(
  sessions: Map<string, BlobUploadSession>,
  token: string,
  body: unknown,
  now = Date.now(),
): BlobChunkResult {
  const stepped = applyIndexedChunk(sessions, token, body, {
    maxBytes: MAX_BLOB_BYTES,
    maxChunks: MAX_CHUNKS,
    tooLargeError: "ATTACHMENT_TOO_LARGE",
    tooLargeStatus: 413,
    extra: (raw) => ({
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "image.jpg",
      mime: typeof raw.mime === "string" ? raw.mime : "",
    }),
  }, now);
  if ("error" in stepped || "pending" in stepped) return stepped;
  return { complete: stepped.complete, name: stepped.extra.name, mime: stepped.extra.mime };
}
