import { ARMADA_HOME, loadToken } from "../hub/src/auth";
import { redeemPairInvite, writeRelayConfig } from "../hub/src/pairRedeem";
import { loadRelayConfig } from "../hub/src/relayClient";
import { startRelayAttach } from "../hub/src/relayAttach";

const home = ARMADA_HOME();
if (!loadRelayConfig(home) && process.env.ARMADA_PAIR_URI) {
  const cfg = await redeemPairInvite(process.env.ARMADA_PAIR_URI);
  writeRelayConfig(home, cfg);
}
const token = loadToken(home);
const hubPort = Number(process.env.ARMADA_HUB_PORT ?? 7380);
const attach = startRelayAttach({ home, hubPort, token });
if (!attach) {
  console.error("armada-relay-attach: missing or invalid ~/.armada/relay.json (or ARMADA_PAIR_URI)");
  process.exit(1);
}
console.log(`armada-relay-attach: hub http://127.0.0.1:${hubPort} → relay.json`);
process.on("SIGINT", () => { attach.stop(); process.exit(0); });
process.on("SIGTERM", () => { attach.stop(); process.exit(0); });
