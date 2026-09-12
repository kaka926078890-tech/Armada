import { latestRunIdForConversation } from "./binding";

export type AskInspectOption = { id: string; label: string; text: string };

export type AskInspect =
  | { present: false }
  | { present: true; prompt: string; conversation_id: string; options: AskInspectOption[] };

export type PendingAskPayload = {
  request_id: string;
  questions: [{ id: "q0"; prompt: string; options: AskInspectOption[] }];
  detected_at: number;
  detect_via: "cdp";
  conversation_id: string;
};

export type AskPollAct =
  | { type: "askQuestion"; runId: string; payload: PendingAskPayload }
  | { type: "askQuestionResolved"; runId: string; request_id: string };

export function parseAskInspect(raw: unknown): AskInspect {
  if (!raw || typeof raw !== "object") return { present: false };
  const o = raw as Record<string, unknown>;
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
    options.push({ id, label, text });
  }
  return { present: true, prompt, conversation_id, options };
}

export function nextAskAction(
  prevRequestId: string | null,
  inspect: AskInspect,
  makeId: () => string,
  now = Date.now(),
): { type: "askQuestion"; payload: PendingAskPayload } | { type: "askQuestionResolved"; request_id: string } | null {
  if (!inspect.present) {
    if (!prevRequestId) return null;
    return { type: "askQuestionResolved", request_id: prevRequestId };
  }
  if (prevRequestId) return null;
  if (inspect.options.length === 0) return null;
  return {
    type: "askQuestion",
    payload: {
      request_id: makeId(),
      questions: [{ id: "q0", prompt: inspect.prompt, options: inspect.options }],
      detected_at: now,
      detect_via: "cdp",
      conversation_id: inspect.conversation_id,
    },
  };
}

/** Questions 只挂拥有该 composer cid 的 run；无 cid / 无主人则不发。禁止 last-key。 */
export function askPollActions(
  bound: Iterable<[string, { conversationId: string }]>,
  prevByRun: Iterable<[string, string]>,
  inspect: AskInspect,
  makeId: (runId: string) => string,
  now = Date.now(),
): AskPollAct[] {
  const widgetCid = inspect.present ? inspect.conversation_id : undefined;
  const owner = latestRunIdForConversation(bound, widgetCid);
  const prev = new Map(prevByRun);
  const out: AskPollAct[] = [];
  for (const [runId, requestId] of prev) {
    if (runId === owner) continue;
    out.push({ type: "askQuestionResolved", runId, request_id: requestId });
  }
  if (!inspect.present || !owner) return out;
  const act = nextAskAction(prev.get(owner) ?? null, inspect, () => makeId(owner), now);
  if (act?.type === "askQuestion") out.push({ type: "askQuestion", runId: owner, payload: act.payload });
  return out;
}
