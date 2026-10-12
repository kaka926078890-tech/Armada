export const DESK_CHUNK_BYTES = 64 * 1024;
export const DESK_IDLE_MS = 15_000;
export const DESK_RATE_WINDOW_MS = 10_000;
export const DESK_RATE_MAX = 120;
export const DESK_WS_MAX = 8;

export function stripDesktopQuery(pathWithQuery: string): string {
  const i = pathWithQuery.indexOf("?");
  if (i < 0) return pathWithQuery;
  const path = pathWithQuery.slice(0, i);
  const params = new URLSearchParams(pathWithQuery.slice(i + 1));
  params.delete("token");
  params.delete("desktop");
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

export type DeskRoute =
  | { kind: "health" }
  | { kind: "ws" }
  | { kind: "miss" }
  | { kind: "http"; upstream: string; stream: boolean };

export function routeDesktop(pathname: string, search: string): DeskRoute {
  if (pathname === "/desktop/health") return { kind: "health" };
  if (pathname === "/desktop/ws") return { kind: "ws" };
  let rest: string | null = null;
  if (pathname === "/desktop" || pathname === "/desktop/") rest = "/";
  else if (pathname.startsWith("/desktop/")) rest = pathname.slice("/desktop".length);
  if (!rest?.startsWith("/")) return { kind: "miss" };
  const upstream = stripDesktopQuery(`${rest}${search}`);
  const pathOnly = upstream.split("?")[0] ?? upstream;
  const stream = pathOnly === "/api/events" || /^\/api\/runs\/[^/]+\/stream$/.test(pathOnly);
  return { kind: "http", upstream, stream };
}

export function splitUtf8(text: string, maxBytes = DESK_CHUNK_BYTES): string[] {
  const buf = Buffer.from(text);
  if (buf.length === 0) return [""];
  if (buf.length <= maxBytes) return [text];
  const parts: string[] = [];
  let i = 0;
  while (i < buf.length) {
    let end = Math.min(i + maxBytes, buf.length);
    while (end > i && end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
    if (end === i) end = Math.min(i + maxBytes, buf.length);
    parts.push(buf.subarray(i, end).toString("utf8"));
    i = end;
  }
  return parts;
}

export function byteFrames(bytes: Uint8Array, maxBytes = DESK_CHUNK_BYTES): { seq: number; last: boolean; bodyBase64?: string }[] {
  if (bytes.length === 0) return [{ seq: 0, last: true }];
  const frames: { seq: number; last: boolean; bodyBase64?: string }[] = [];
  const n = Math.ceil(bytes.length / maxBytes);
  for (let seq = 0; seq < n; seq++) {
    const slice = bytes.subarray(seq * maxBytes, Math.min(bytes.length, (seq + 1) * maxBytes));
    frames.push({ seq, last: seq === n - 1, bodyBase64: Buffer.from(slice).toString("base64") });
  }
  return frames;
}

export function textFrames(text: string, maxBytes = DESK_CHUNK_BYTES): { seq: number; last: boolean; data: string }[] {
  const parts = splitUtf8(text, maxBytes);
  return parts.map((data, seq) => ({ seq, last: seq === parts.length - 1, data }));
}

export class PartAssembler<T> {
  private parts = new Map<number, T>();
  private last: number | null = null;
  private join: (parts: T[]) => T;

  constructor(join: (parts: T[]) => T) {
    this.join = join;
  }

  push(seq: number, last: boolean, part: T): { ok: true; done: false } | { ok: true; done: true; value: T } | { ok: false } {
    if (!Number.isInteger(seq) || seq < 0 || this.parts.has(seq)) return { ok: false };
    this.parts.set(seq, part);
    if (last) {
      if (this.last != null) return { ok: false };
      this.last = seq;
    }
    if (this.last == null) return { ok: true, done: false };
    for (let i = 0; i <= this.last; i++) if (!this.parts.has(i)) return { ok: true, done: false };
    const ordered: T[] = [];
    for (let i = 0; i <= this.last; i++) ordered.push(this.parts.get(i) as T);
    return { ok: true, done: true, value: this.join(ordered) };
  }
}

export function byteAssembler(): PartAssembler<Uint8Array> {
  return new PartAssembler((parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  });
}

export function textAssembler(): PartAssembler<string> {
  return new PartAssembler((parts) => parts.join(""));
}

export function decodeBody(bodyBase64?: string): Uint8Array {
  if (!bodyBase64) return new Uint8Array();
  return new Uint8Array(Buffer.from(bodyBase64, "base64"));
}

export function forwardRequestHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const contentType = headers.get("content-type");
  const accept = headers.get("accept");
  if (contentType) out["content-type"] = contentType;
  if (accept) out.accept = accept;
  return out;
}
