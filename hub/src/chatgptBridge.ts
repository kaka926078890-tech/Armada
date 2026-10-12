import type { Database } from "bun:sqlite";
import { hostname, homedir } from "os";
import { join } from "path";
import {
  attachChatgpt, CHATGPT_LOCAL_MACHINE, sameHost, type ChatgptMachineView,
} from "./chatgptAttach";
import { boardTargets } from "./chatgptDesktop";
import { prepareAndSend } from "./chatgptDrive";
import {
  chatgptAppRunning, chatgptPortUp, connectChatgptPage, readRolloutFile, recentRolloutFiles, relaunchChatgptWithPort,
} from "./chatgptCdp";
import type { Registry } from "./registry";
import type { RunService } from "./runs";
import type { SseHub } from "./sse";

const BIND_TIMEOUT_MS = 45_000;

export class ChatgptBridge {
  private viewState: ChatgptMachineView = { port: "absent", targets: [] };
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private launching = false;
  private fingerprint = "";

  constructor(
    private db: Database,
    private runs: RunService,
    private registry: Registry,
    private sse: SseHub,
  ) {}

  view(): ChatgptMachineView {
    return this.viewState;
  }

  machines<T extends { id: string; name: string; os: string; status: string }>(rows: T[]): T[] {
    return attachChatgpt(rows, this.viewState, hostname());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 2000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async launchMonitor(): Promise<{ ok: true } | { error: string }> {
    if (this.launching) return { error: "CHATGPT_PORT_DOWN" };
    if (!chatgptAppRunning()) return { error: "CHATGPT_NOT_RUNNING" };
    this.launching = true;
    try {
      await relaunchChatgptWithPort();
      await this.tick();
      return { ok: true };
    } catch (err) {
      const code = err instanceof Error && err.message.startsWith("CHATGPT_") ? err.message : "CHATGPT_PORT_DOWN";
      return { error: code };
    } finally {
      this.launching = false;
    }
  }

  private publish(next: ChatgptMachineView): void {
    const fp = JSON.stringify(next);
    this.viewState = next;
    this.runs.setChatgptRoots(next.port === "ready" ? next.targets.map((item) => item.root) : []);
    if (fp === this.fingerprint) return;
    this.fingerprint = fp;
    this.sse.broadcast("*", { type: "machine.updated" });
  }

  private ensureLocalRow(): void {
    const rows = this.registry.listMachines();
    const local = rows.filter((machine) => machine.id !== CHATGPT_LOCAL_MACHINE && machine.os.startsWith("darwin") && sameHost(machine.name, hostname()));
    if (local.some((machine) => machine.status === "online")) {
      this.db.query("UPDATE machines SET status='offline', open_workspaces='[]' WHERE id=?1 AND status!='offline'")
        .run(CHATGPT_LOCAL_MACHINE);
      return;
    }
    const now = Date.now();
    this.db.query(
      `INSERT INTO machines (id, name, os, open_workspaces, status, last_seen_at)
       VALUES (?1,?2,'darwin','[]','online',?3)
       ON CONFLICT(id) DO UPDATE SET status='online', last_seen_at=?3, name=?2`,
    ).run(CHATGPT_LOCAL_MACHINE, hostname(), now);
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.launching) return;
    this.ticking = true;
    try {
      const up = await chatgptPortUp();
      if (!up) {
        const running = chatgptAppRunning();
        if (running) this.ensureLocalRow();
        else this.db.query("UPDATE machines SET status='offline' WHERE id=?1").run(CHATGPT_LOCAL_MACHINE);
        this.publish(running ? { port: "down", targets: [] } : { port: "absent", targets: [] });
      } else {
        const page = await connectChatgptPage();
        try {
          const targets = boardTargets(await page.controls());
          this.ensureLocalRow();
          this.publish({ port: "ready", targets });
        } finally {
          page.close();
        }
      }
      this.runs.expireUnboundChatgpt(Date.now() - BIND_TIMEOUT_MS);
      await this.feedRollouts();
      await this.drain();
    } catch {
      /* 这一拍读不到页面就等下一拍，不把已发出的任务标失败 */
    } finally {
      this.ticking = false;
    }
  }

  private async feedRollouts(): Promise<void> {
    const active = this.runs.activeChatgptRuns();
    if (!active.length) return;
    const files = recentRolloutFiles(join(homedir(), ".codex", "sessions"), Date.now() - 10 * 60 * 1000);
    for (const file of files) {
      const jsonl = readRolloutFile(file);
      if (!jsonl) continue;
      for (const run of active) this.runs.noteChatgptRollout(run.id, jsonl);
    }
  }

  private async drain(): Promise<void> {
    if (this.viewState.port !== "ready") return;
    const run = this.runs.claimChatgptSend();
    if (!run) return;
    let page;
    try {
      page = await connectChatgptPage();
      await prepareAndSend(page, run.workspace_root, run.prompt);
    } catch (err) {
      const code = err instanceof Error && err.message.startsWith("CHATGPT_") ? err.message : "CHATGPT_SEND_FAILED";
      this.runs.failChatgpt(run.id, code);
    } finally {
      page?.close();
    }
  }
}
