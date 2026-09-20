import { MAX_BLOB_BYTES } from "../../hub/src/blobs";

/** Public uuWAF in front of armada.finogeeks.club 500s HTML above ~10KiB. Keep JSON bodies under that. */
export const BLOB_UPLOAD_CHUNK_BYTES = 6 * 1024;
export const BLOB_UPLOAD_TTL_MS = 60_000;
const MAX_CHUNKS = Math.ceil(MAX_BLOB_BYTES / 1024);
const MAX_CHUNK_DECODED = 8 * 1024;

export type BlobUploadSession = {
  token: string;
  name: string;
  mime: string;
  totalSize: number;
  count: number;
  parts: Array<Buffer | undefined>;
  createdAt: number;
};

export type BlobChunkResult =
  | { error: string; status: number }
  | { pending: true }
  | { complete: Buffer; name: string; mime: string };

export function sweepBlobUploads(sessions: Map<string, BlobUploadSession>, now = Date.now()): void {
  for (const [id, ses] of sessions) {
    if (now - ses.createdAt > BLOB_UPLOAD_TTL_MS) sessions.delete(id);
  }
}

export function applyBlobChunk(
  sessions: Map<string, BlobUploadSession>,
  token: string,
  body: unknown,
  now = Date.now(),
): BlobChunkResult {
  sweepBlobUploads(sessions, now);
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "INVALID", status: 400 };
  const o = body as Record<string, unknown>;
  const uploadId = typeof o.uploadId === "string" ? o.uploadId.trim() : "";
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "image.jpg";
  const mime = typeof o.mime === "string" ? o.mime : "";
  const totalSize = Number(o.totalSize);
  const index = Number(o.index);
  const count = Number(o.count);
  const data = typeof o.data === "string" ? o.data : "";
  if (!uploadId || uploadId.length > 80) return { error: "INVALID", status: 400 };
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    return { error: "INVALID", status: 400 };
  }
  if (count > MAX_CHUNKS) return { error: "INVALID", status: 400 };
  if (!Number.isFinite(totalSize) || totalSize <= 0 || totalSize > MAX_BLOB_BYTES) {
    return { error: "ATTACHMENT_TOO_LARGE", status: 413 };
  }
  if (!data) return { error: "INVALID", status: 400 };
  let bytes: Buffer;
  try { bytes = Buffer.from(data, "base64"); } catch { return { error: "INVALID", status: 400 }; }
  if (!bytes.length || bytes.length > MAX_CHUNK_DECODED) return { error: "INVALID", status: 400 };

  let ses = sessions.get(uploadId);
  if (!ses) {
    ses = { token, name, mime, totalSize, count, parts: new Array(count), createdAt: now };
    sessions.set(uploadId, ses);
  } else if (ses.token !== token) {
    return { error: "unauthorized", status: 401 };
  } else if (ses.count !== count || ses.totalSize !== totalSize) {
    return { error: "INVALID", status: 400 };
  }
  ses.parts[index] = bytes;
  for (let i = 0; i < ses.count; i++) {
    if (!ses.parts[i]) return { pending: true };
  }

  const all = Buffer.concat(ses.parts as Buffer[]);
  sessions.delete(uploadId);
  if (all.length !== totalSize) return { error: "INVALID", status: 400 };
  if (all.length > MAX_BLOB_BYTES) return { error: "ATTACHMENT_TOO_LARGE", status: 413 };
  return { complete: all, name: ses.name, mime: ses.mime };
}
