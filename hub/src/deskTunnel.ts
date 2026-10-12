import {
  byteAssembler,
  byteFrames,
  decodeBody,
  splitUtf8,
  textAssembler,
  textFrames,
} from "../../relay/src/desktopFrames";

type LocalWs = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onmessage: ((data: string | Buffer) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
};

function defaultOpen(url: string): LocalWs {
  const ws = new WebSocket(url);
  const local: LocalWs = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onmessage: null,
    onclose: null,
  };
  ws.addEventListener("message", (ev) => {
    const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer);
    local.onmessage?.(data);
  });
  ws.addEventListener("close", (ev) => {
    local.onclose?.(ev.code, ev.reason);
  });
  return local;
}

export function createDeskTunnel(deps: {
  hubFetch: (path: string, init?: RequestInit) => Promise<Response>;
  send: (msg: object) => void;
  localWsUrl: string;
  openLocalWs?: (url: string) => LocalWs;
}) {
  const httpIn = new Map<string, { asm: ReturnType<typeof byteAssembler>; method: string; path: string; headers: Record<string, string> }>();
  const locals = new Map<string, LocalWs>();
  const textIn = new Map<string, ReturnType<typeof textAssembler>>();

  async function finishHttp(streamId: string, method: string, path: string, headers: Record<string, string>, body: Uint8Array) {
    const init: RequestInit = { method, headers };
    if (body.length > 0 && method !== "GET" && method !== "HEAD") init.body = body;
    const res = await deps.hubFetch(path, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const respHeaders: Record<string, string> = {};
    const contentType = res.headers.get("content-type");
    if (contentType) respHeaders["content-type"] = contentType;
    for (const frame of byteFrames(bytes)) {
      deps.send({ type: "desk.http.result", streamId, status: res.status, headers: respHeaders, ...frame });
    }
  }

  async function openStream(streamId: string, path: string) {
    const res = await deps.hubFetch(path, { method: "GET", headers: { accept: "text/event-stream" } });
    const reader = res.body?.getReader();
    if (!reader) {
      deps.send({ type: "desk.stream.end", streamId, status: res.status });
      return;
    }
    const dec = new TextDecoder();
    let seq = 0;
    const emit = (text: string) => {
      for (const data of splitUtf8(text)) {
        if (!data) continue;
        deps.send({ type: "desk.stream.chunk", streamId, seq: seq++, data });
      }
    };
    while (true) {
      const step = await reader.read();
      if (step.done) {
        emit(dec.decode());
        deps.send({ type: "desk.stream.end", streamId, status: res.status });
        return;
      }
      emit(dec.decode(step.value, { stream: true }));
    }
  }

  function openWs(streamId: string) {
    const local = (deps.openLocalWs ?? defaultOpen)(deps.localWsUrl);
    locals.set(streamId, local);
    local.onmessage = (data) => {
      if (typeof data !== "string") {
        local.close(1003, "binary");
        return;
      }
      for (const frame of textFrames(data)) deps.send({ type: "desk.ws.frame", streamId, ...frame });
    };
    local.onclose = (code, reason) => {
      locals.delete(streamId);
      textIn.delete(streamId);
      deps.send({ type: "desk.ws.close", streamId, code, reason });
    };
  }

  return async function onDesk(msg: any) {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("desk.")) return;
    const streamId = typeof msg.streamId === "string" ? msg.streamId : "";
    if (msg.type === "desk.http") {
      let slot = httpIn.get(streamId);
      if (!slot) {
        slot = {
          asm: byteAssembler(),
          method: typeof msg.method === "string" ? msg.method : "GET",
          path: typeof msg.path === "string" ? msg.path : "/",
          headers: msg.headers && typeof msg.headers === "object" ? msg.headers : {},
        };
        httpIn.set(streamId, slot);
      }
      const pushed = slot.asm.push(Number(msg.seq), msg.last === true, decodeBody(typeof msg.bodyBase64 === "string" ? msg.bodyBase64 : undefined));
      if (!pushed.ok) {
        httpIn.delete(streamId);
        return;
      }
      if (!pushed.done) return;
      httpIn.delete(streamId);
      await finishHttp(streamId, slot.method, slot.path, slot.headers, pushed.value);
      return;
    }
    if (msg.type === "desk.stream.open") {
      await openStream(streamId, typeof msg.path === "string" ? msg.path : "/api/events");
      return;
    }
    if (msg.type === "desk.ws.open") {
      openWs(streamId);
      return;
    }
    if (msg.type === "desk.ws.frame") {
      const local = locals.get(streamId);
      if (!local || typeof msg.data !== "string" || typeof msg.seq !== "number") return;
      let asm = textIn.get(streamId);
      if (!asm) {
        asm = textAssembler();
        textIn.set(streamId, asm);
      }
      const pushed = asm.push(msg.seq, msg.last === true, msg.data);
      if (!pushed.ok || !pushed.done) return;
      textIn.delete(streamId);
      local.send(pushed.value);
      return;
    }
    if (msg.type === "desk.ws.close") {
      const local = locals.get(streamId);
      if (!local) return;
      locals.delete(streamId);
      textIn.delete(streamId);
      local.onclose = null;
      local.close(typeof msg.code === "number" ? msg.code : 1000, typeof msg.reason === "string" ? msg.reason : "");
    }
  };
}
