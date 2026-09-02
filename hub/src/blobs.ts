import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";

export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

export type BlobMeta = { id: string; sha256: string; mime: string; name: string; size: number };

export function detectImageMime(buf: Buffer): "image/png" | "image/jpeg" | null {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(PNG)) return "image/png";
  if (buf.length >= 3 && buf.subarray(0, 3).equals(JPEG)) return "image/jpeg";
  return null;
}

export function blobsDir(home: string): string {
  return join(home, "blobs");
}

const QUOTA_BYTES = 512 * 1024 * 1024;
const QUOTA_AUDIT_EVERY_MS = 60 * 60 * 1000;

export class BlobStore {
  private uploads: number[] = [];
  private inFlight = 0;
  private lastQuotaAudit = 0;

  constructor(private db: Database, private home: string) {
    mkdirSync(blobsDir(home), { recursive: true });
  }

  put(bytes: Buffer, declaredMime: string, name: string, now = Date.now()): { error?: string; blob?: BlobMeta; status?: number } {
    if (this.inFlight >= 2) return { error: "RATE_LIMIT", status: 429 };
    this.inFlight += 1;
    try {
      const window = this.uploads.filter((t) => now - t < 60_000);
      this.uploads = window;
      if (window.length >= 10) return { error: "RATE_LIMIT", status: 429 };

      if (bytes.length > MAX_BLOB_BYTES) return { error: "ATTACHMENT_TOO_LARGE", status: 413 };
      const magic = detectImageMime(bytes);
      if (!magic) return { error: "ATTACHMENT_INVALID_MIME", status: 400 };
      if ((declaredMime === "image/png" || declaredMime === "image/jpeg") && declaredMime !== magic) {
        return { error: "ATTACHMENT_INVALID_MIME", status: 400 };
      }
      const mime = magic;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const path = join(blobsDir(this.home), sha256);
      const existing = this.db.query("SELECT sha256 FROM blobs WHERE sha256=?1").get(sha256) as { sha256: string } | null;
      if (!existing) {
        writeFileSync(path, bytes);
        this.db.query("INSERT INTO blobs (sha256, mime, size, refcount, created_at, unref_at) VALUES (?1,?2,?3,0,?4,?4)")
          .run(sha256, mime, bytes.length, now);
      }
      this.uploads.push(now);
      const row = this.db.query("SELECT mime, size FROM blobs WHERE sha256=?1").get(sha256) as { mime: string; size: number };
      return { blob: { id: sha256, sha256, mime: row.mime, name: name || `${sha256.slice(0, 8)}.${mime === "image/png" ? "png" : "jpg"}`, size: row.size } };
    } finally {
      this.inFlight -= 1;
    }
  }

  get(id: string): { bytes: Buffer; mime: string } | null {
    const row = this.db.query("SELECT mime, size FROM blobs WHERE sha256=?1").get(id) as { mime: string; size: number } | null;
    if (!row) return null;
    const path = join(blobsDir(this.home), id);
    if (!existsSync(path)) return null;
    return { bytes: readFileSync(path), mime: row.mime };
  }

  metas(ids: string[]): { error?: string; items?: BlobMeta[]; status?: number } {
    if (ids.length > MAX_ATTACHMENTS) return { error: "ATTACHMENT_COUNT", status: 400 };
    const items: BlobMeta[] = [];
    let total = 0;
    for (const id of ids) {
      const row = this.db.query("SELECT mime, size FROM blobs WHERE sha256=?1").get(id) as { mime: string; size: number } | null;
      if (!row) return { error: "ATTACHMENT_NOT_FOUND", status: 400 };
      total += row.size;
      items.push({ id, sha256: id, mime: row.mime, name: id.slice(0, 8), size: row.size });
    }
    if (total > MAX_TOTAL_BYTES) return { error: "ATTACHMENT_TOTAL_TOO_LARGE", status: 413 };
    return { items };
  }

  applyRefDelta(oldIds: string[], newIds: string[], now = Date.now()): void {
    const delta = new Map<string, number>();
    for (const id of oldIds) delta.set(id, (delta.get(id) ?? 0) - 1);
    for (const id of newIds) delta.set(id, (delta.get(id) ?? 0) + 1);
    for (const [id, d] of delta) {
      if (d === 0) continue;
      this.db.query("UPDATE blobs SET refcount = MAX(0, refcount + ?1) WHERE sha256=?2").run(d, id);
      const row = this.db.query("SELECT refcount FROM blobs WHERE sha256=?1").get(id) as { refcount: number } | null;
      if (!row) continue;
      if (row.refcount <= 0) {
        this.db.query("UPDATE blobs SET unref_at=?1 WHERE sha256=?2 AND unref_at IS NULL").run(now, id);
      } else {
        this.db.query("UPDATE blobs SET unref_at=NULL WHERE sha256=?1").run(id);
      }
    }
  }

  sweep(now = Date.now(), ttlMs = 24 * 60 * 60 * 1000): void {
    const rows = this.db.query(
      "SELECT sha256, created_at, unref_at FROM blobs WHERE refcount<=0",
    ).all() as { sha256: string; created_at: number; unref_at: number | null }[];
    for (const r of rows) {
      const zeroAt = r.unref_at ?? r.created_at;
      if (now - zeroAt < ttlMs) continue;
      const path = join(blobsDir(this.home), r.sha256);
      try { unlinkSync(path); } catch { /* missing */ }
      this.db.query("DELETE FROM blobs WHERE sha256=?1").run(r.sha256);
    }
    const total = (this.db.query("SELECT COALESCE(SUM(size),0) AS n FROM blobs").get() as { n: number }).n;
    if (total > QUOTA_BYTES && now - this.lastQuotaAudit >= QUOTA_AUDIT_EVERY_MS) {
      this.lastQuotaAudit = now;
      this.db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'hub','blobs.quota','*',?2)")
        .run(now, JSON.stringify({ bytes: total, limit: QUOTA_BYTES }));
    }
  }
}

export function parseAttachmentIds(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
