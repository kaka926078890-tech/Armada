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

/** Hub-issued gen for platforms without beforeSubmitPrompt (Windows). Empty is ignored. */
export function noteHubGeneration(map: Map<string, string>, runId: string, generationId: unknown): void {
  const gen = typeof generationId === "string" ? generationId : "";
  if (!gen) return;
  map.set(runId, gen);
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
