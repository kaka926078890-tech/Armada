export class SseHub {
  private clients = new Map<string, Set<ReadableStreamDefaultController>>();

  register(channel: string, controller: ReadableStreamDefaultController): () => void {
    if (!this.clients.has(channel)) this.clients.set(channel, new Set());
    this.clients.get(channel)!.add(controller);
    return () => this.clients.get(channel)?.delete(controller);
  }

  broadcast(runId: string, event: object): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const ch of [runId, "*"]) {
      for (const c of this.clients.get(ch) ?? []) {
        try { c.enqueue(new TextEncoder().encode(data)); } catch { /* closed */ }
      }
    }
  }

  closeAll(): void {
    for (const set of this.clients.values()) for (const c of set) { try { c.close(); } catch {} }
    this.clients.clear();
  }
}
