import { join } from "path";
import { loadApnsFromEnv, applyHomeEnv } from "./apns";
import { loadFcmFromEnv } from "./fcm";
import { createRelayServer } from "./server";
import { resolveAdminToken, adminTokenLogLine } from "./adminToken";

const port = Number(process.env.RELAY_PORT ?? 8780);
const hostname = process.env.RELAY_HOST ?? "127.0.0.1";
const home = process.env.RELAY_HOME ?? join(process.env.HOME!, ".armada-relay");
applyHomeEnv(home);
const publicBase = (process.env.RELAY_PUBLIC_BASE ?? `http://${hostname}:${port}`).replace(/\/+$/, "");
const admin = resolveAdminToken(home, process.env.RELAY_ADMIN_TOKEN);

const apns = loadApnsFromEnv();
const fcm = loadFcmFromEnv();
const s = createRelayServer({ port, hostname, home, publicBase, adminToken: admin.token, apns, fcm });
console.log(`armada-relay listening on http://${hostname}:${s.port}`);
console.log(`armada-relay publicBase=${s.publicBase} home=${home}`);
console.log(`armada-relay admin header X-Relay-Admin (set RELAY_ADMIN_TOKEN in production)`);
const adminLog = adminTokenLogLine(admin);
if (adminLog) console.log(adminLog);
if (process.argv.includes("--create-fleet")) {
  console.log(JSON.stringify(s.createFleet(), null, 2));
}
