export function noteOwnerBsp(
  map: Map<string, string>,
  runId: string,
  hook: string,
  payload: { generation_id?: unknown; conversation_id?: unknown },
  ownerCid: string | undefined,
): void {
  if (hook !== "beforeSubmitPrompt") return;
  const gen = typeof payload.generation_id === "string" ? payload.generation_id : "";
  const cid = typeof payload.conversation_id === "string" ? payload.conversation_id : "";
  if (!gen || !ownerCid || cid !== ownerCid || gen === cid) return;
  map.set(runId, gen);
}

export function clearGeneration(map: Map<string, string>, runId: string): void {
  map.delete(runId);
}

/**
 * Followup attach fromEnd. FollowupStopGuard already blocks the previous
 * turn_ended; this must not drop the hub-issued gen for this turn's synth stop.
 */
export function onFollowupBindGeneration(map: Map<string, string>, runId: string): void {
  const keep = map.get(runId);
  clearGeneration(map, runId);
  noteHubGeneration(map, runId, keep);
}

/** Hub-issued gen for platforms without beforeSubmitPrompt (Windows). Empty is ignored. */
export function noteHubGeneration(map: Map<string, string>, runId: string, generationId: unknown): void {
  const gen = typeof generationId === "string" ? generationId : "";
  if (!gen) return;
  map.set(runId, gen);
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
