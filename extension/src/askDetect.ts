export type AskInspectOption = { id: string; label: string; text: string };

export type AskInspect =
  | { present: false }
  | { present: true; prompt: string; options: AskInspectOption[] };

export type PendingAskPayload = {
  request_id: string;
  questions: [{ id: "q0"; prompt: string; options: AskInspectOption[] }];
  detected_at: number;
  detect_via: "cdp";
};

export function parseAskInspect(raw: unknown): AskInspect {
  if (!raw || typeof raw !== "object") return { present: false };
  const o = raw as Record<string, unknown>;
  if (o.present !== true) return { present: false };
  const prompt = typeof o.prompt === "string" && o.prompt.trim() ? o.prompt.trim() : "Questions";
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
  return { present: true, prompt, options };
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
    },
  };
}
