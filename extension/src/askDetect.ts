import { latestRunIdForConversation } from "./binding";

export type AskInspectOption = { id: string; label: string; text: string; freeform?: boolean };

export type AskInspect =
  | { present: false }
  | { unknown: true; reason: string }
  | {
    present: true;
    prompt: string;
    conversation_id: string;
    options: AskInspectOption[];
    kind?: "plan";
    filename?: string;
    skip_unidentified?: boolean;
  };

function isAskUnknown(inspect: AskInspect): inspect is { unknown: true; reason: string } {
  return "unknown" in inspect && inspect.unknown === true;
}

/** present:true wins. unknown only if no successful inspect. Confirmed false otherwise. */
export function coalesceAskInspect(hits: AskInspect[]): AskInspect {
  let unknown: { unknown: true; reason: string } | undefined;
  let sawConfirmed = false;
  for (const hit of hits) {
    if (isAskUnknown(hit)) {
      unknown = hit;
      continue;
    }
    sawConfirmed = true;
    if (hit.present) return hit;
  }
  if (!sawConfirmed && unknown) return unknown;
  return { present: false };
}

export type PlanInspect =
  | { present: false }
  | { present: true; filename: string; overview: string; conversation_id: string };

export type PendingAskPayload = {
  request_id: string;
  questions: [{ id: "q0"; prompt: string; options: AskInspectOption[] }];
  detected_at: number;
  detect_via: "cdp";
  conversation_id: string;
  kind?: "plan";
  filename?: string;
};

export type AskPollAct =
  | { type: "askQuestion"; runId: string; payload: PendingAskPayload }
  | { type: "askQuestionResolved"; runId: string; request_id: string };

export function parseAskInspect(raw: unknown): AskInspect {
  if (!raw || typeof raw !== "object") return { present: false };
  const o = raw as Record<string, unknown>;
  if (o.unknown === true) {
    return { unknown: true, reason: typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : "unknown" };
  }
  if (o.present !== true) return { present: false };
  const prompt = typeof o.prompt === "string" && o.prompt.trim() ? o.prompt.trim() : "Questions";
  const conversation_id = typeof o.conversation_id === "string" ? o.conversation_id.trim() : "";
  const optsRaw = Array.isArray(o.options) ? o.options : [];
  const options: AskInspectOption[] = [];
  for (const item of optsRaw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim().toLowerCase() : "";
    const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : id.toUpperCase();
    const text = typeof r.text === "string" && r.text.trim() ? r.text.trim() : label;
    if (!id) continue;
    const opt: AskInspectOption = { id, label, text };
    if (r.freeform === true) opt.freeform = true;
    options.push(opt);
  }
  return {
    present: true,
    prompt,
    conversation_id,
    options,
    ...(o.kind === "plan" ? { kind: "plan" as const } : {}),
    ...(typeof o.filename === "string" && o.filename.trim() ? { filename: o.filename.trim() } : {}),
    ...(o.skip_unidentified === true ? { skip_unidentified: true } : {}),
  };
}

export function parsePlanInspect(raw: unknown): PlanInspect {
  if (!raw || typeof raw !== "object") return { present: false };
  const o = raw as Record<string, unknown>;
  if (o.present !== true) return { present: false };
  const filename = typeof o.filename === "string" && o.filename.trim() ? o.filename.trim() : "";
  if (!filename) return { present: false };
  const overview = typeof o.overview === "string" ? o.overview.replace(/\s+/g, " ").trim() : "";
  const conversation_id = typeof o.conversation_id === "string" ? o.conversation_id.trim() : "";
  return { present: true, filename, overview, conversation_id };
}

export function planInspectToAsk(inspect: PlanInspect): AskInspect {
  if (!inspect.present) return { present: false };
  return {
    present: true,
    kind: "plan",
    filename: inspect.filename,
    prompt: `Created Plan: ${inspect.filename}`,
    conversation_id: inspect.conversation_id,
    options: [{ id: "build", label: "Build", text: inspect.overview || "Build" }],
  };
}

export function nextAskAction(
  prevRequestId: string | null,
  inspect: AskInspect,
  makeId: () => string,
  now = Date.now(),
  prevPlanText?: string,
): { type: "askQuestion"; payload: PendingAskPayload } | { type: "askQuestionResolved"; request_id: string } | null {
  if (isAskUnknown(inspect)) return null;
  if (!inspect.present) {
    if (!prevRequestId) return null;
    return { type: "askQuestionResolved", request_id: prevRequestId };
  }
  if (inspect.options.length === 0) return null;
  const payload = (request_id: string): PendingAskPayload => ({
    request_id,
    questions: [{ id: "q0", prompt: inspect.prompt, options: inspect.options }],
    detected_at: now,
    detect_via: "cdp",
    conversation_id: inspect.conversation_id,
    ...(inspect.kind === "plan" ? { kind: "plan" as const, filename: inspect.filename } : {}),
  });
  if (prevRequestId) {
    if (inspect.kind === "plan") {
      const text = inspect.options[0]?.text ?? "";
      if (text && text !== prevPlanText) return { type: "askQuestion", payload: payload(prevRequestId) };
    }
    return null;
  }
  return { type: "askQuestion", payload: payload(makeId()) };
}

function boundConversationId(
  bound: Iterable<[string, { conversationId: string }]>,
  runId: string,
): string | undefined {
  for (const [id, v] of bound) {
    if (id === runId) return v.conversationId;
  }
  return undefined;
}

function uniqueBoundRunId(bound: Iterable<[string, { conversationId: string }]>): string | undefined {
  let only: string | undefined;
  for (const [runId] of bound) {
    if (only) return undefined;
    only = runId;
  }
  return only;
}

/** Questions 只挂拥有该 composer cid 的 run。无 cid 时仅唯一仍活的 bound run 可挂；已停跑不得 last-key。Plan/Build 可挂停跑主人以便 hub 复开。 */
export function askPollActions(
  bound: Iterable<[string, { conversationId: string }]>,
  prevByRun: Iterable<[string, string]>,
  inspect: AskInspect,
  makeId: (runId: string) => string,
  now = Date.now(),
  stopped: Iterable<string> = [],
  prevPlanTextByRun: Iterable<[string, string]> = [],
): AskPollAct[] {
  if (isAskUnknown(inspect)) return [];
  const dead = inspect.present && inspect.kind === "plan" ? new Set<string>() : new Set(stopped);
  const live = [...bound].filter(([id]) => !dead.has(id));
  const widgetCid = inspect.present ? inspect.conversation_id : undefined;
  const owner = latestRunIdForConversation(live, widgetCid)
    ?? (inspect.present && !widgetCid ? uniqueBoundRunId(live) : undefined);
  const prev = new Map(prevByRun);
  const prevText = new Map(prevPlanTextByRun);
  const out: AskPollAct[] = [];
  for (const [runId, requestId] of prev) {
    if (runId === owner) continue;
    out.push({ type: "askQuestionResolved", runId, request_id: requestId });
  }
  if (!inspect.present || !owner) return out;
  const act = nextAskAction(prev.get(owner) ?? null, inspect, () => makeId(owner), now, prevText.get(owner));
  if (act?.type === "askQuestion") {
    const conversation_id = act.payload.conversation_id || boundConversationId(live, owner) || "";
    out.push({ type: "askQuestion", runId: owner, payload: { ...act.payload, conversation_id } });
  }
  return out;
}
