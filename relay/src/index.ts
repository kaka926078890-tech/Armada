import { join } from "path";
import { createRelayServer } from "./server";

const port = Number(process.env.RELAY_PORT ?? 8780);
const hostname = process.env.RELAY_HOST ?? "127.0.0.1";
const home = process.env.RELAY_HOME ?? join(process.env.HOME!, ".armada-relay");
const publicBase = (process.env.RELAY_PUBLIC_BASE ?? `http://${hostname}:${port}`).replace(/\/+$/, "");
const adminToken = process.env.RELAY_ADMIN_TOKEN;

const s = createRelayServer({ port, hostname, home, publicBase, adminToken });
console.log(`armada-relay listening on http://${hostname}:${s.port}`);
console.log(`armada-relay publicBase=${s.publicBase} home=${home}`);
console.log(`armada-relay admin header X-Relay-Admin (set RELAY_ADMIN_TOKEN in production)`);
if (!process.env.RELAY_ADMIN_TOKEN) {
  console.log(`armada-relay generated admin token: ${s.adminToken}`);
}
if (process.argv.includes("--create-fleet")) {
  console.log(JSON.stringify(s.createFleet(), null, 2));
}
