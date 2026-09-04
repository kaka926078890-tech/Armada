export function genOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function parseRetiredIds(raw: unknown): { ids: string[]; parseFailed: boolean } {
  if (raw == null || raw === "") return { ids: [], parseFailed: false };
  if (Array.isArray(raw)) {
    return { ids: raw.filter((x): x is string => typeof x === "string"), parseFailed: false };
  }
  if (typeof raw !== "string") return { ids: [], parseFailed: true };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ids: [], parseFailed: true };
    return { ids: parsed.filter((x): x is string => typeof x === "string"), parseFailed: false };
  } catch {
    return { ids: [], parseFailed: true };
  }
}

export function appendRetired(ids: string[], gen: string | null | undefined, cap = 32): string[] {
  const g = genOf(gen);
  if (!g) return ids;
  const next = ids.includes(g) ? ids : [...ids, g];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export type ArmInput = {
  hookEventName: string | null | undefined;
  generationId: unknown;
  eventCid: unknown;
  runConversationId: string | null | undefined;
  liveGenerationId: string | null | undefined;
  retired: string[];
};

export type ArmDecision =
  | { action: "arm"; gen: string }
  | { action: "skip"; reason: string };

export function decideArm(input: ArmInput): ArmDecision {
  if (input.hookEventName !== "beforeSubmitPrompt") return { action: "skip", reason: "not_bsp" };
  const gen = genOf(input.generationId);
  if (!gen) return { action: "skip", reason: "no_gen" };
  const cid = typeof input.eventCid === "string" ? input.eventCid : null;
  const owner = input.runConversationId ?? null;
  if (!cid || !owner || cid !== owner) return { action: "skip", reason: "cid_mismatch" };
  if (gen === cid) return { action: "skip", reason: "gen_eq_cid" };
  if (input.retired.includes(gen)) return { action: "skip", reason: "retired" };
  if (input.liveGenerationId && input.liveGenerationId === gen) return { action: "skip", reason: "already_armed_same" };
  if (input.liveGenerationId) return { action: "skip", reason: "already_armed" };
  return { action: "arm", gen };
}

export type StopInput = {
  stopCid: unknown;
  runConversationId: string | null | undefined;
  stopGenerationId: unknown;
  liveGenerationId: string | null | undefined;
  hasHubFollowup: boolean;
  retired: string[];
};

export type StopDecision =
  | { action: "apply"; audit?: "STOP_NO_GEN_INITIAL" }
  | { action: "ignore"; audit: string };

export function decideStop(input: StopInput): StopDecision {
  const owner = input.runConversationId ?? null;
  const stopCid = typeof input.stopCid === "string" && input.stopCid ? input.stopCid : null;
  if (stopCid && owner && stopCid !== owner) return { action: "ignore", audit: "STOP_CID_MISMATCH" };
  const gen = genOf(input.stopGenerationId);
  if (gen && input.retired.includes(gen)) return { action: "ignore", audit: "STOP_GEN_RETIRED" };
  const live = genOf(input.liveGenerationId);
  if (gen && live && gen === live) return { action: "apply" };
  if (gen && live && gen !== live) return { action: "ignore", audit: "STOP_GEN_MISMATCH" };
  if (gen && !live) return { action: "ignore", audit: "STOP_UNARMED" };
  if (!gen && live) return { action: "ignore", audit: "STOP_NO_GEN" };
  if (!gen && !live && input.hasHubFollowup) return { action: "ignore", audit: "STOP_NO_GEN" };
  return { action: "apply", audit: "STOP_NO_GEN_INITIAL" };
}
