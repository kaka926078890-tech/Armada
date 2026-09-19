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

export const FILE_EXTS = new Set(["pdf", "txt", "md", "json", "csv", "xml", "yaml", "yml", "html", "htm", "log"]);

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  log: "text/plain",
};

export function detectImageMime(buf: Buffer): "image/png" | "image/jpeg" | null {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(PNG)) return "image/png";
  if (buf.length >= 3 && buf.subarray(0, 3).equals(JPEG)) return "image/jpeg";
  return null;
}

export function isImageMime(mime: string): boolean {
  return mime === "image/png" || mime === "image/jpeg";
}

export function isInlineRenderMime(mime: string): boolean {
  return isImageMime(mime);
}

export function responseContentType(mime: string): string {
  return isInlineRenderMime(mime) ? mime : "application/octet-stream";
}

export function extOf(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function detectBlobKind(bytes: Buffer, name: string): { mime: string } | null {
  const image = detectImageMime(bytes);
  if (image) return { mime: image };
  const ext = extOf(name);
  if (!FILE_EXTS.has(ext)) return null;
  if (ext === "pdf") {
    if (bytes.length < 4 || bytes.subarray(0, 4).toString("ascii") !== "%PDF") return null;
    return { mime: "application/pdf" };
  }
  return { mime: MIME_BY_EXT[ext] ?? "text/plain" };
}

export function safeBlobName(name: string, mime: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || "";
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff-]+/g, "_").replace(/^\.+/, "");
  if (cleaned) return cleaned.slice(0, 120);
  if (mime === "image/png") return "image.png";
  if (mime === "image/jpeg") return "image.jpg";
  const ext = extOf(name);
  return ext ? `file.${ext}` : "file";
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

  beginUpload(): { error?: string; status?: number } {
    if (this.inFlight >= 2) return { error: "RATE_LIMIT", status: 429 };
    this.inFlight += 1;
    return {};
  }

  endUpload(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  put(bytes: Buffer, declaredMime: string, name: string, now = Date.now()): { error?: string; blob?: BlobMeta; status?: number } {
    const window = this.uploads.filter((t) => now - t < 60_000);
    this.uploads = window;
    if (window.length >= 10) return { error: "RATE_LIMIT", status: 429 };

    if (bytes.length > MAX_BLOB_BYTES) return { error: "ATTACHMENT_TOO_LARGE", status: 413 };
    const kind = detectBlobKind(bytes, name);
    if (!kind) return { error: "ATTACHMENT_INVALID_MIME", status: 400 };
    if ((declaredMime === "image/png" || declaredMime === "image/jpeg") && declaredMime !== kind.mime) {
      return { error: "ATTACHMENT_INVALID_MIME", status: 400 };
    }
    const mime = kind.mime;
    const storedName = safeBlobName(name, mime);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(blobsDir(this.home), sha256);
    const existing = this.db.query("SELECT sha256, name FROM blobs WHERE sha256=?1").get(sha256) as { sha256: string; name?: string } | null;
    if (!existing) {
      writeFileSync(path, bytes);
      this.db.query("INSERT INTO blobs (sha256, mime, size, refcount, created_at, unref_at, name) VALUES (?1,?2,?3,0,?4,?4,?5)")
        .run(sha256, mime, bytes.length, now, storedName);
    } else if (!(existing.name ?? "").trim()) {
      this.db.query("UPDATE blobs SET name=?1 WHERE sha256=?2").run(storedName, sha256);
    }
    this.uploads.push(now);
    const row = this.db.query("SELECT mime, size, name FROM blobs WHERE sha256=?1").get(sha256) as { mime: string; size: number; name: string };
    return { blob: { id: sha256, sha256, mime: row.mime, name: row.name || storedName, size: row.size } };
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
      const row = this.db.query("SELECT mime, size, name FROM blobs WHERE sha256=?1").get(id) as { mime: string; size: number; name: string } | null;
      if (!row) return { error: "ATTACHMENT_NOT_FOUND", status: 400 };
      total += row.size;
      items.push({ id, sha256: id, mime: row.mime, name: row.name || id.slice(0, 8), size: row.size });
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

  /** refcount = runs whose attachments JSON currently lists the sha; unref_at only stamps when first hitting 0. */
  syncRefsFromRuns(now = Date.now()): void {
    const runRows = this.db.query("SELECT attachments FROM runs").all() as { attachments: string }[];
    const counts = new Map<string, number>();
    for (const r of runRows) {
      const seen = new Set<string>();
      for (const id of parseAttachmentIds(r.attachments)) {
        if (seen.has(id)) continue;
        seen.add(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const blobs = this.db.query("SELECT sha256, unref_at FROM blobs").all() as { sha256: string; unref_at: number | null }[];
    for (const row of blobs) {
      const refcount = counts.get(row.sha256) ?? 0;
      const unrefAt = refcount > 0 ? null : (row.unref_at ?? now);
      this.db.query("UPDATE blobs SET refcount=?1, unref_at=?2 WHERE sha256=?3").run(refcount, unrefAt, row.sha256);
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
