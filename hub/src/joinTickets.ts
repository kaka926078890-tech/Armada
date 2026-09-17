import { randomBytes } from "crypto";
import type { Database } from "bun:sqlite";

export const JOIN_TICKET_PREFIX = "jt_";
export const JOIN_TICKET_TTL_MS = 30 * 60 * 1000;
const TICKET_RE = /^jt_[0-9a-f]{64}$/;

export function isJoinTicket(cred: string): boolean {
  return TICKET_RE.test(cred);
}

export class JoinTickets {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS join_tickets (
      ticket TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`);
  }

  mint(now = Date.now()): { ticket: string; expiresAt: number } {
    this.db.query("DELETE FROM join_tickets").run();
    const ticket = JOIN_TICKET_PREFIX + randomBytes(32).toString("hex");
    const expiresAt = now + JOIN_TICKET_TTL_MS;
    this.db.query("INSERT INTO join_tickets (ticket, expires_at) VALUES (?1, ?2)").run(ticket, expiresAt);
    return { ticket, expiresAt };
  }

  exchange(ticket: string, now = Date.now()): boolean {
    if (!isJoinTicket(ticket)) return false;
    const row = this.db.query("SELECT expires_at FROM join_tickets WHERE ticket=?1").get(ticket) as
      | { expires_at: number }
      | undefined;
    return !!row && row.expires_at >= now;
  }

  revoke(): void {
    this.db.query("DELETE FROM join_tickets").run();
  }
}
