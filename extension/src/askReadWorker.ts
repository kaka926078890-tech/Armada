import { parentPort } from "node:worker_threads";
import { readStoredAsksSync } from "./askStore";

type AskReadRequest = { id: number; cids: string[]; home: string; platform: string };

parentPort?.on("message", (msg: AskReadRequest) => {
  void readStoredAsksSync(msg.cids, msg.home, msg.platform)
    .then((asks) => parentPort?.postMessage({ id: msg.id, asks }))
    .catch(() => parentPort?.postMessage({ id: msg.id, asks: null }));
});
