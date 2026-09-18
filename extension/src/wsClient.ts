export class ReconnectPolicy {
  nextDelay(attempt: number): number {
    return Math.min(1000 * 2 ** attempt, 30_000);
  }
}

function msgKey(m: object): string | null {
  const t = (m as { type?: string }).type;
  if (t === "run.ack" || t === "run.bound") return `${t}:${(m as { runId?: string }).runId ?? ""}`;
  if (t === "run.event" && (m as { hookEventName?: string }).hookEventName === "stop") {
    return `stop:${(m as { runId?: string }).runId ?? ""}`;
  }
  return null;
}

/** Hub sweep is 45s; three missed heartbeat.ack windows means the socket is dead. */
export const WS_STALE_MS = 45_000;
export const WS_HEARTBEAT_MS = 15_000;

/**
 * 出站队列:TCP 已连上 ≠ hub 已 register。
 * 若 onOpen 立刻 flush,hooks.status / run.ack 会排在 register 前,
 * hub 回 4001,队列被冲掉,派发 ack 丢失 → DISPATCH_TIMEOUT(真机 desk 窗口实测)。
 *
 * 当前窗 newAgentChat 会把 WS 打成 1006:此时 ready 仍可能为 true,ack 发到死链路。
 * run.ack / run.bound 必须进 reliable,onClose 塞回队列,重连 registered 后再发。
 *
 * 后台窗 hub 重启时 close 可能丢：ready 仍 true，心跳打进死套接字。
 * 存活闸：registered 之后若 WS_STALE_MS 内没有入站（heartbeat.ack / 其它消息）则强制重连。
 */
export class WsClientCore {
  private queue: object[] = [];
  private reliable = new Map<string, object>();
  private ready = false;
  private lastInboundAt = 0;
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
    this.noteInbound();
    for (const m of this.queue) this.sender(m);
    this.queue = [];
  }

  onClose(): number {
    this.ready = false;
    this.lastInboundAt = 0;
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

  noteInbound(now = Date.now()): void {
    this.lastInboundAt = now;
  }

  shouldReconnect(now = Date.now(), staleMs = WS_STALE_MS): boolean {
    if (!this.ready) return false;
    if (this.lastInboundAt === 0) return true;
    return now - this.lastInboundAt >= staleMs;
  }

  private pushQueue(msg: object): void {
    const k = msgKey(msg);
    if (k) this.queue = this.queue.filter((m) => msgKey(m) !== k);
    this.queue.push(msg);
  }
}
