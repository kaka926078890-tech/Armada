export const OCCUPYING_STATUSES = ["queued", "dispatched", "binding", "running"] as const;
export const INJECTING_STATUSES = ["dispatched", "binding"] as const;
export const PROGRESSING_STATUSES = ["dispatched", "binding", "running"] as const;
export const RETRY_STATUSES = ["error", "unknown", "aborted"] as const;
export const TERMINAL_STATUSES = ["completed", "error", "aborted", "cancelled"] as const;
export const ACTIVE_STATUSES = ["created", "dispatched", "binding", "running"] as const;
export const LIVE_STATUSES = ["created", "queued", "dispatched", "binding", "running"] as const;
export const ENDED_STATUSES = ["completed", "error", "aborted", "cancelled", "unknown"] as const;

export function sqlStatusIn(statuses: readonly string[]): string {
  return statuses.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
}

export function isStatus(status: string, statuses: readonly string[]): boolean {
  return (statuses as readonly string[]).includes(status);
}
