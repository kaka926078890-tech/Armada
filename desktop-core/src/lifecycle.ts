export function joinMaySpawnHub(): false {
  return false;
}

/** caffeinate flags: prevent idle + system sleep while the owned hub pid is alive. */
export function keepAwakeArgs(pid: number): string[] {
  return ["-i", "-s", "-w", String(pid)];
}

