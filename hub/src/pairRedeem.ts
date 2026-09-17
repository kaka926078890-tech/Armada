import { writeFileSync } from "fs";
import { join } from "path";
import { parseRelayUri } from "../../relay/src/uri";
import type { RelayConfig } from "./relayClient";

const HEX64 = /^[a-f0-9]{64}$/;

export async function redeemPairInvite(pairUri: string, fetchImpl: typeof fetch = fetch): Promise<RelayConfig> {
  const parsed = parseRelayUri(pairUri);
  if ("error" in parsed || parsed.kind !== "pair") throw new Error("invalid");
  if (parsed.secret && HEX64.test(parsed.secret)) {
    return { relay: parsed.relay, fleet: parsed.fleet, secret: parsed.secret };
  }
  if (!parsed.code || !HEX64.test(parsed.code)) throw new Error("incomplete");
  const r = await fetchImpl(`${parsed.relay}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fleet: parsed.fleet, code: parsed.code }),
  });
  if (r.status === 410) throw new Error("PAIR_USED");
  if (!r.ok) throw new Error("unauthorized");
  const j = await r.json() as { secret?: string };
  if (typeof j.secret !== "string" || !HEX64.test(j.secret)) throw new Error("incomplete");
  return { relay: parsed.relay, fleet: parsed.fleet, secret: j.secret };
}

export function writeRelayConfig(home: string, cfg: RelayConfig): void {
  writeFileSync(
    join(home, "relay.json"),
    JSON.stringify({ relay: cfg.relay, fleet: cfg.fleet, secret: cfg.secret }),
    { mode: 0o600 },
  );
}
