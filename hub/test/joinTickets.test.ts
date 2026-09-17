import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type HubServer } from "../src/index";
import { JOIN_TICKET_PREFIX, isJoinTicket } from "../src/joinTickets";

let hub: HubServer | null = null;
afterEach(() => { hub?.stop(); hub = null; });

function start() {
  const home = mkdtempSync(join(tmpdir(), "armada-jt-"));
  hub = createServer({ port: 0, home });
  return hub;
}

describe("join tickets", () => {
  test("mint requires operator token; exchange returns it without broadcasting the long-lived token", async () => {
    const s = start();
    const denied = await fetch(`http://127.0.0.1:${s.port}/api/join-tickets`, { method: "POST" });
    expect(denied.status).toBe(401);

    const minted = await fetch(`http://127.0.0.1:${s.port}/api/join-tickets`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(minted.status).toBe(201);
    const j = await minted.json() as { ticket: string; expiresAt: number };
    expect(isJoinTicket(j.ticket)).toBe(true);
    expect(j.ticket.startsWith(JOIN_TICKET_PREFIX)).toBe(true);
    expect(j.ticket).not.toBe(s.token);
    expect(j.expiresAt).toBeGreaterThan(Date.now());

    const exchanged = await fetch(`http://127.0.0.1:${s.port}/join/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: j.ticket }),
    });
    expect(exchanged.status).toBe(200);
    expect(await exchanged.json()).toEqual({ token: s.token });
  });

  test("unknown or revoked ticket is 401", async () => {
    const s = start();
    const miss = await fetch(`http://127.0.0.1:${s.port}/join/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: `${JOIN_TICKET_PREFIX}${"a".repeat(64)}` }),
    });
    expect(miss.status).toBe(401);

    const minted = await fetch(`http://127.0.0.1:${s.port}/api/join-tickets`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}` },
    });
    const { ticket } = await minted.json() as { ticket: string };
    await fetch(`http://127.0.0.1:${s.port}/api/join-tickets`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${s.token}` },
    });
    const after = await fetch(`http://127.0.0.1:${s.port}/join/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    expect(after.status).toBe(401);
  });
});
