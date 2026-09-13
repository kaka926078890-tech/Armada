import { ARMADA_HOME, loadToken } from "../hub/src/auth";
import { startRelayAttach } from "../hub/src/relayAttach";

const home = ARMADA_HOME();
const token = loadToken(home);
const hubPort = Number(process.env.ARMADA_HUB_PORT ?? 7380);
const attach = startRelayAttach({ home, hubPort, token });
if (!attach) {
  console.error("armada-relay-attach: missing or invalid ~/.armada/relay.json");
  process.exit(1);
}
console.log(`armada-relay-attach: hub http://127.0.0.1:${hubPort} → relay.json`);
process.on("SIGINT", () => { attach.stop(); process.exit(0); });
process.on("SIGTERM", () => { attach.stop(); process.exit(0); });
