/** Public uuWAF in front of armada.finogeeks.club 500s HTML above ~10KiB. Keep JSON bodies under that. */
export const WAF_JSON_CHUNK_BYTES = 6 * 1024;
export const WAF_JSON_BODY_MAX = 10 * 1024;
export const CHUNK_UPLOAD_TTL_MS = 60_000;
export const MAX_CHUNK_DECODED = 8 * 1024;
export const MAX_OPERATOR_BODY = 20 * 1024 * 1024;

export type IndexedChunkSession<T> = {
  token: string;
  totalSize: number;
  count: number;
  parts: Array<Buffer | undefined>;
  createdAt: number;
  extra: T;
};

export type IndexedChunkResult<T> =
  | { error: string; status: number }
  | { pending: true }
  | { complete: Buffer; extra: T };

export function sweepChunkUploads<T>(sessions: Map<string, IndexedChunkSession<T>>, now = Date.now()): void {
  for (const [id, ses] of sessions) {
    if (now - ses.createdAt > CHUNK_UPLOAD_TTL_MS) sessions.delete(id);
  }
}

export function applyIndexedChunk<T>(
  sessions: Map<string, IndexedChunkSession<T>>,
  token: string,
  body: unknown,
  opts: {
    maxBytes: number;
    maxChunks: number;
    tooLargeError: string;
    tooLargeStatus: number;
    extra: (raw: Record<string, unknown>) => T;
    mergeExtra?: (prev: T, next: T) => T;
  },
  now = Date.now(),
): IndexedChunkResult<T> {
  sweepChunkUploads(sessions, now);
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "INVALID", status: 400 };
  const o = body as Record<string, unknown>;
  const uploadId = typeof o.uploadId === "string" ? o.uploadId.trim() : "";
  const totalSize = Number(o.totalSize);
  const index = Number(o.index);
  const count = Number(o.count);
  const data = typeof o.data === "string" ? o.data : "";
  if (!uploadId || uploadId.length > 80) return { error: "INVALID", status: 400 };
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    return { error: "INVALID", status: 400 };
  }
  if (count > opts.maxChunks) return { error: "INVALID", status: 400 };
  if (!Number.isFinite(totalSize) || totalSize <= 0 || totalSize > opts.maxBytes) {
    return { error: opts.tooLargeError, status: opts.tooLargeStatus };
  }
  if (!data) return { error: "INVALID", status: 400 };
  let bytes: Buffer;
  try { bytes = Buffer.from(data, "base64"); } catch { return { error: "INVALID", status: 400 }; }
  if (!bytes.length || bytes.length > MAX_CHUNK_DECODED) return { error: "INVALID", status: 400 };

  const extra = opts.extra(o);
  let ses = sessions.get(uploadId);
  if (!ses) {
    ses = { token, totalSize, count, parts: new Array(count), createdAt: now, extra };
    sessions.set(uploadId, ses);
  } else if (ses.token !== token) {
    return { error: "unauthorized", status: 401 };
  } else if (ses.count !== count || ses.totalSize !== totalSize) {
    return { error: "INVALID", status: 400 };
  } else if (opts.mergeExtra) {
    ses.extra = opts.mergeExtra(ses.extra, extra);
  }
  ses.parts[index] = bytes;
  for (let i = 0; i < ses.count; i++) {
    if (!ses.parts[i]) return { pending: true };
  }

  const all = Buffer.concat(ses.parts as Buffer[]);
  sessions.delete(uploadId);
  if (all.length !== totalSize) return { error: "INVALID", status: 400 };
  if (all.length > opts.maxBytes) return { error: opts.tooLargeError, status: opts.tooLargeStatus };
  return { complete: all, extra: ses.extra };
}
