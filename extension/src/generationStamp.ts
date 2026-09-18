import { appendRetired, decideArm } from "../../hub/src/generationOwnership";

/** Retired gens for a live-stamp map. Same decideArm retired list hub persists. */
const retiredByLiveMap = new WeakMap<Map<string, string>, Map<string, string[]>>();

function retiredStore(live: Map<string, string>): Map<string, string[]> {
  let byRun = retiredByLiveMap.get(live);
  if (!byRun) {
    byRun = new Map();
    retiredByLiveMap.set(live, byRun);
  }
  return byRun;
}

function retiredIds(live: Map<string, string>, runId: string): string[] {
  return retiredStore(live).get(runId) ?? [];
}

function setLive(map: Map<string, string>, runId: string, gen: string, retire?: string): void {
  const retired = retire
    ? appendRetired(retiredIds(map, runId), retire)
    : retiredIds(map, runId);
  if (retire) retiredStore(map).set(runId, retired);
  map.set(runId, gen);
}

/**
 * Mirror hub `decideArm` into the synth-stop stamp.
 * BSP and owner-cid UUID `preToolUse` arm/rearm; sidecar / thought / child cid skip.
 */
export function noteOwnerBsp(
  map: Map<string, string>,
  runId: string,
  hook: string,
  payload: { generation_id?: unknown; conversation_id?: unknown },
  ownerCid: string | undefined,
): void {
  const d = decideArm({
    hookEventName: hook,
    generationId: payload.generation_id,
    eventCid: payload.conversation_id,
    runConversationId: ownerCid,
    liveGenerationId: map.get(runId) ?? null,
    retired: retiredIds(map, runId),
  });
  if (d.action === "arm") {
    setLive(map, runId, d.gen);
    return;
  }
  if (d.action === "rearm") setLive(map, runId, d.gen, d.retire);
}

export function clearGeneration(map: Map<string, string>, runId: string): void {
  map.delete(runId);
  retiredStore(map).delete(runId);
}

/**
 * Followup attach fromEnd. FollowupStopGuard already blocks the previous
 * turn_ended; this must not drop the hub-issued gen for this turn's synth stop.
 * Retired gens stay retired so a stale BSP cannot win the stamp back.
 */
export function onFollowupBindGeneration(map: Map<string, string>, runId: string): void {
  const keep = map.get(runId);
  map.delete(runId);
  noteHubGeneration(map, runId, keep);
}

/** Hub-issued gen for platforms without beforeSubmitPrompt (Windows). Empty is ignored. */
export function noteHubGeneration(map: Map<string, string>, runId: string, generationId: unknown): void {
  const gen = typeof generationId === "string" ? generationId : "";
  if (!gen) return;
  const live = map.get(runId);
  if (live && live !== gen) setLive(map, runId, gen, live);
  else map.set(runId, gen);
}

/** jsonl `turn_ended` is the durable idle signal. Hooks can miss it on every OS. */
export function shouldSynthesizeTranscriptStop(_platform: string = process.platform): boolean {
  return true;
}

export function synthesizedStopPayload(
  stop: { status: string; error?: string },
  lastGenerationId: string | undefined,
  conversationId: string | undefined,
): { ok: true; payload: Record<string, unknown> } | { ok: false } {
  if (!lastGenerationId) return { ok: false };
  return {
    ok: true,
    payload: { ...stop, generation_id: lastGenerationId, conversation_id: conversationId },
  };
}
