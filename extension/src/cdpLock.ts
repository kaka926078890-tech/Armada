import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "fs";
import { dirname } from "path";

export type CdpLockOk = { ok: true; release: () => void };
export type CdpLockFail = { ok: false; reason: "CDP_LOCK_TIMEOUT" };
export type CdpLockResult = CdpLockOk | CdpLockFail;

const POLL_MS = 50;
/** Darwin fcntl.h O_EXLOCK — libuv/Node/Bun do not export this constant. */
const O_EXLOCK = constants.O_EXLOCK ?? 0x20;

export async function acquireCdpLock(opts: {
  lockPath: string;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<CdpLockResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  mkdirSync(dirname(opts.lockPath), { recursive: true });

  if (process.platform === "darwin") {
    return acquireExlock(opts.lockPath, deadline, sleep, now);
  }
  return acquirePidFile(opts.lockPath, deadline, sleep, now);
}

async function acquireExlock(
  lockPath: string,
  deadline: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<CdpLockResult> {
  const flags = constants.O_CREAT | constants.O_RDWR | O_EXLOCK | constants.O_NONBLOCK;
  while (true) {
    try {
      const fd = openSync(lockPath, flags);
      return {
        ok: true,
        release: () => {
          try { closeSync(fd); } catch { /* already closed */ }
        },
      };
    } catch (e) {
      if (!isBusy(e)) throw e;
      if (now() >= deadline) return { ok: false, reason: "CDP_LOCK_TIMEOUT" };
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
    }
  }
}

async function acquirePidFile(
  lockPath: string,
  deadline: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<CdpLockResult> {
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}\n`);
      return {
        ok: true,
        release: () => {
          try { closeSync(fd); } catch { /* already closed */ }
          try { unlinkSync(lockPath); } catch { /* already gone */ }
        },
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e;
      if (canSteal(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* raced */ }
        continue;
      }
      if (now() >= deadline) return { ok: false, reason: "CDP_LOCK_TIMEOUT" };
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
    }
  }
}

function isBusy(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES";
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function canSteal(lockPath: string): boolean {
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    return !pidAlive(pid);
  } catch {
    return true;
  }
}
