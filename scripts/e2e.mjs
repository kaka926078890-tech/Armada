#!/usr/bin/env node
// Armada E2E:起 hub(临时 HOME)→ 假扩展 WS 全生命周期 → 断言 REST/SSE/审计。
// Run: bun run scripts/e2e.mjs   (要求 bun install 已执行)
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../hub/src/index.ts";

const home = mkdtempSync(join(tmpdir(), "armada-e2e-"));
const hub = createServer({ port: 0, home });
const base = `http://127.0.0.1:${hub.port}`;
const H = { "content-type": "application/json", authorization: `Bearer ${hub.token}` };
let failures = 0;
const check = (name, cond) => { console.log(cond ? `  ✅ ${name}` : `  ❌ ${name}`); if (!cond) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** REST-poll until run reaches `expected` status or timeout. */
async function waitRunStatus(runId, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await (await fetch(`${base}/api/runs/${runId}`, { headers: H })).json();
    if (run.status === expected) return run;
    await sleep(50);
  }
  throw new Error(`timeout waiting for run ${runId} → ${expected}`);
}

/** Parse accumulated SSE text into data: JSON objects. */
function parseSseDataFrames(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try { out.push(JSON.parse(line.slice(6))); } catch { /* incomplete/partial */ }
  }
  return out;
}

/** Poll until SSE buffer has both run.status and run.event, or timeout. */
async function waitSseTypes(getText, types, timeoutMs = 2000) {
  const needed = new Set(types);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = new Set(parseSseDataFrames(getText()).map((m) => m.type));
    if ([...needed].every((t) => seen.has(t))) return true;
    await sleep(50);
  }
  return false;
}

console.log("armada e2e on", base);

try {
  // 1. 未授权 401
  check("401 without token", (await fetch(`${base}/api/machines`)).status === 401);

  // 2. 假扩展注册（WS open 5s 超时，避免升级失败挂死）
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws?token=${hub.token}`);
  const inbound = [];
  ws.addEventListener("message", (e) => inbound.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WS open timeout (5s)")), 5000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e) => { clearTimeout(t); reject(e); };
  });
  ws.send(JSON.stringify({ type: "register", machineId: "m-e2e", windowId: "w-1", name: "E2E-Mac", os: "darwin-arm64", openWorkspaces: ["/ws/demo"] }));
  await sleep(150);
  check("registered", inbound.some((m) => m.type === "registered"));
  const machines = await (await fetch(`${base}/api/machines`, { headers: H })).json();
  check("machine online via REST", machines[0]?.status === "online");

  // 3. 派发 → ack → bound → 事件 → stop（含 SSE 订阅）
  const created = await (await fetch(`${base}/api/runs`, { method: "POST", headers: H, body: JSON.stringify({ machineId: "m-e2e", workspaceRoot: "/ws/demo", prompt: "e2e prompt" }) })).json();
  check("run dispatched", created.run?.status === "dispatched");
  await sleep(100);
  check("run.start received", inbound.some((m) => m.type === "run.start" && m.runId === created.run.id));

  let sseBuf = "";
  const sseAbort = new AbortController();
  const sseRes = await fetch(`${base}/api/runs/${created.run.id}/stream`, { headers: H, signal: sseAbort.signal });
  const sseReader = sseRes.body.getReader();
  const sseDecoder = new TextDecoder();
  (async () => {
    try {
      while (true) {
        const { done, value } = await sseReader.read();
        if (done) break;
        sseBuf += sseDecoder.decode(value, { stream: true });
      }
    } catch { /* aborted */ }
  })();

  ws.send(JSON.stringify({ type: "run.ack", runId: created.run.id, status: "accepted" }));
  ws.send(JSON.stringify({ type: "run.bound", runId: created.run.id, conversationId: "cid-e2e", transcriptPath: null, promptMatch: true }));
  await sleep(100);
  ws.send(JSON.stringify({ type: "run.event", runId: created.run.id, source: "hook", hookEventName: "preToolUse", payload: { tool_name: "Shell" }, ts: Date.now(), seq: 1 }));
  ws.send(JSON.stringify({ type: "run.event", runId: created.run.id, source: "hook", hookEventName: "stop", payload: { status: "completed" }, ts: Date.now(), seq: 2 }));

  const sseOk = await waitSseTypes(() => sseBuf, ["run.status", "run.event"], 2000);
  sseAbort.abort();
  try { await sseReader.cancel(); } catch {}
  const sseMsgs = parseSseDataFrames(sseBuf);
  check("SSE run.status frame", sseOk && sseMsgs.some((m) => m.type === "run.status"));
  check("SSE run.event frame", sseOk && sseMsgs.some((m) => m.type === "run.event"));

  const finalRun = await waitRunStatus(created.run.id, "completed");
  check("run completed", finalRun.status === "completed");
  const events = await (await fetch(`${base}/api/runs/${created.run.id}/events`, { headers: H })).json();
  check("2 events with per-run seq", events.length === 2 && events[0].seq === 1 && events[1].seq === 2);
  check("event.ack received", inbound.some((m) => m.type === "event.ack" && m.machineId === "m-e2e" && m.lastSeq === 2));

  // 4. 取消流:新 run → cancel → run.cancel 下发 → stop.aborted → cancelled
  const r2 = await (await fetch(`${base}/api/runs`, { method: "POST", headers: H, body: JSON.stringify({ machineId: "m-e2e", workspaceRoot: "/ws/demo", prompt: "cancel me" }) })).json();
  ws.send(JSON.stringify({ type: "run.ack", runId: r2.run.id, status: "accepted" }));
  ws.send(JSON.stringify({ type: "run.bound", runId: r2.run.id, conversationId: "cid-2", transcriptPath: null, promptMatch: false }));
  await sleep(100);
  await fetch(`${base}/api/runs/${r2.run.id}/cancel`, { method: "POST", headers: H });
  await sleep(100);
  check("run.cancel pushed to ext", inbound.some((m) => m.type === "run.cancel" && m.runId === r2.run.id));
  ws.send(JSON.stringify({ type: "run.event", runId: r2.run.id, source: "hook", hookEventName: "stop", payload: { status: "aborted" }, ts: Date.now(), seq: 3 }));
  await waitRunStatus(r2.run.id, "cancelled");
  check("cancelled terminal", (await (await fetch(`${base}/api/runs/${r2.run.id}`, { headers: H })).json()).status === "cancelled");

  // 5. 去重:同 machine 同 ext_seq 只落一条，仍回 event.ack
  const r3 = await (await fetch(`${base}/api/runs`, { method: "POST", headers: H, body: JSON.stringify({ machineId: "m-e2e", workspaceRoot: "/ws/demo", prompt: "dedup me" }) })).json();
  ws.send(JSON.stringify({ type: "run.ack", runId: r3.run.id, status: "accepted" }));
  ws.send(JSON.stringify({ type: "run.bound", runId: r3.run.id, conversationId: "cid-3", transcriptPath: null, promptMatch: true }));
  await sleep(100);
  const ackBefore = inbound.filter((m) => m.type === "event.ack" && m.lastSeq === 10).length;
  ws.send(JSON.stringify({ type: "run.event", runId: r3.run.id, source: "hook", hookEventName: "preToolUse", payload: { tool_name: "Shell" }, ts: Date.now(), seq: 10 }));
  ws.send(JSON.stringify({ type: "run.event", runId: r3.run.id, source: "hook", hookEventName: "preToolUse", payload: { tool_name: "Shell" }, ts: Date.now(), seq: 10 }));
  await sleep(150);
  const dedupEvents = await (await fetch(`${base}/api/runs/${r3.run.id}/events`, { headers: H })).json();
  check("dedup keeps single event", dedupEvents.length === 1);
  check("dedup still acks duplicate", inbound.filter((m) => m.type === "event.ack" && m.lastSeq === 10).length >= ackBefore + 2);
  ws.send(JSON.stringify({ type: "run.event", runId: r3.run.id, source: "hook", hookEventName: "stop", payload: { status: "completed" }, ts: Date.now(), seq: 11 }));
  // r4 创建前必须确认 r3 已终态，避免机并发 1 时 RUN_BUSY
  await waitRunStatus(r3.run.id, "completed");

  // 6. 离线清扫:backdate last_seen → sweep → machine offline + running→unknown
  const r4 = await (await fetch(`${base}/api/runs`, { method: "POST", headers: H, body: JSON.stringify({ machineId: "m-e2e", workspaceRoot: "/ws/demo", prompt: "offline me" }) })).json();
  check("r4 created", !!r4.run?.id);
  ws.send(JSON.stringify({ type: "run.ack", runId: r4.run.id, status: "accepted" }));
  ws.send(JSON.stringify({ type: "run.bound", runId: r4.run.id, conversationId: "cid-4", transcriptPath: null, promptMatch: true }));
  await sleep(100);
  hub.db.query("UPDATE machines SET last_seen_at=?1 WHERE id='m-e2e'").run(Date.now() - 60_000);
  hub.registry.sweep();
  const afterSweep = await (await fetch(`${base}/api/machines`, { headers: H })).json();
  check("sweep marks machine offline", afterSweep.find((m) => m.id === "m-e2e")?.status === "offline");
  check("offline run → unknown", (await (await fetch(`${base}/api/runs/${r4.run.id}`, { headers: H })).json()).status === "unknown");

  // 7. 审计导出
  const audit = await (await fetch(`${base}/api/audit/export`, { headers: H })).text();
  check("audit JSONL non-empty", audit.trim().split("\n").length >= 5);

  ws.close();
} finally {
  hub.stop();
}

console.log(failures === 0 ? "\nE2E PASS" : `\nE2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
