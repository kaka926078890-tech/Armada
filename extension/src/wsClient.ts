export class ReconnectPolicy {
  nextDelay(attempt: number): number {
    return Math.min(1000 * 2 ** attempt, 30_000);
  }
}

function msgKey(m: object): string | null {
  const t = (m as { type?: string }).type;
  if (t === "run.ack" || t === "run.bound") return `${t}:${(m as { runId?: string }).runId ?? ""}`;
  return null;
}

/**
 * 出站队列:TCP 已连上 ≠ hub 已 register。
 * 若 onOpen 立刻 flush,hooks.status / run.ack 会排在 register 前,
 * hub 回 4001,队列被冲掉,派发 ack 丢失 → DISPATCH_TIMEOUT(真机 desk 窗口实测)。
 *
 * 当前窗 newAgentChat 会把 WS 打成 1006:此时 ready 仍可能为 true,ack 发到死链路。
 * run.ack / run.bound 必须进 reliable,onClose 塞回队列,重连 registered 后再发。
 */
export class WsClientCore {
  private queue: object[] = [];
  private reliable = new Map<string, object>();
  private ready = false;
  private attempts = 0;
  private policy = new ReconnectPolicy();
  constructor(
    private sender: (msg: object) => void,
    private isOpen: () => boolean = () => true,
  ) {}

  enqueue(msg: object): void {
    const k = msgKey(msg);
    if (k) this.reliable.set(k, msg);
    if (this.ready && this.isOpen()) this.sender(msg);
    else this.pushQueue(msg);
  }

  /** socket open:只发 register,其它消息等 onRegistered。 */
  onOpen(): void {
    this.attempts = 0;
  }

  sendRegister(msg: object): void {
    this.sender(msg);
  }

  onRegistered(): void {
    this.ready = true;
    for (const m of this.queue) this.sender(m);
    this.queue = [];
  }

  onClose(): number {
    this.ready = false;
    const queuedKeys = new Set(this.queue.map((m) => msgKey(m)).filter((k): k is string => k !== null));
    const rest: object[] = [];
    for (const [k, m] of this.reliable) {
      if (!queuedKeys.has(k)) rest.push(m);
    }
    this.queue = [...rest, ...this.queue];
    const d = this.policy.nextDelay(this.attempts);
    this.attempts += 1;
    return d;
  }

  pendingCount(): number { return this.queue.length; }

  private pushQueue(msg: object): void {
    const k = msgKey(msg);
    if (k) this.queue = this.queue.filter((m) => msgKey(m) !== k);
    this.queue.push(msg);
  }
}
