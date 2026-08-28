export class ReconnectPolicy {
  nextDelay(attempt: number): number {
    return Math.min(1000 * 2 ** attempt, 30_000);
  }
}

export class WsClientCore {
  private queue: object[] = [];
  private open = false;
  private attempts = 0;
  private policy = new ReconnectPolicy();
  constructor(private sender: (msg: object) => void) {}

  enqueue(msg: object): void {
    if (this.open) this.sender(msg);
    else this.queue.push(msg);
  }

  onOpen(): void {
    this.open = true;
    this.attempts = 0;
    for (const m of this.queue) this.sender(m);
    this.queue = [];
  }

  onClose(): number {
    this.open = false;
    const d = this.policy.nextDelay(this.attempts);
    this.attempts += 1;
    return d;
  }

  pendingCount(): number { return this.queue.length; }
}
