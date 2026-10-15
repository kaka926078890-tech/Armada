export const SSE_KEEPALIVE_MS = 5_000;

export class SseHub {
  onEvent?: (runId: string, event: object) => void;
  private clients = new Map<string, Set<ReadableStreamDefaultController>>();

  register(channel: string, controller: ReadableStreamDefaultController): () => void {
    if (!this.clients.has(channel)) this.clients.set(channel, new Set());
    this.clients.get(channel)!.add(controller);
    return () => this.clients.get(channel)?.delete(controller);
  }

  broadcast(runId: string, event: object): void {
    this.onEvent?.(runId, event);
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const ch of [runId, "*"]) {
      for (const c of this.clients.get(ch) ?? []) {
        try { c.enqueue(new TextEncoder().encode(data)); } catch { /* closed */ }
      }
    }
  }

  /** Bun.serve drops a connection after 10 s with no bytes; the comment ping keeps it open. */
  response(channel: string, signal: AbortSignal | undefined, keepaliveMs = SSE_KEEPALIVE_MS): Response {
    const enc = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue(enc.encode(":ok\n\n"));
        const unregister = this.register(channel, controller);
        const ping = setInterval(() => {
          try { controller.enqueue(enc.encode(":ping\n\n")); } catch { stop(); }
        }, keepaliveMs);
        stop = () => { clearInterval(ping); unregister(); };
        signal?.addEventListener("abort", () => { stop(); try { controller.close(); } catch {} });
      },
      cancel: () => stop(),
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  closeAll(): void {
    for (const set of this.clients.values()) for (const c of set) { try { c.close(); } catch {} }
    this.clients.clear();
  }
}
