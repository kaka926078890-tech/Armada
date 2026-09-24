export type PendingAskOption = { id: string; label: string; text: string; freeform?: boolean };

export type PendingAskQuestion = {
  id: string;
  prompt: string;
  allow_multiple?: boolean;
  options: PendingAskOption[];
};

export type PendingAsk = {
  request_id: string;
  questions: PendingAskQuestion[];
  detected_at: number;
  detect_via: "jsonl" | "cdp" | "hook";
  kind?: "plan";
  filename?: string;
  conversation_id?: string;
};

export function isPlanAsk(ask: PendingAsk): boolean {
  return ask.kind === "plan";
}

function asTrimmedString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function parseOption(raw: unknown): PendingAskOption | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = asTrimmedString(o.id);
  const label = asTrimmedString(o.label) ?? asTrimmedString(o.id);
  if (!id || !label) return null;
  const text = asTrimmedString(o.text) ?? asTrimmedString(o.label) ?? id;
  const opt: PendingAskOption = { id, label, text };
  if (o.freeform === true) opt.freeform = true;
  return opt;
}

function parseQuestion(raw: unknown, index: number): PendingAskQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = asTrimmedString(o.id) ?? `q${index}`;
  const prompt = asTrimmedString(o.prompt);
  if (!prompt) return null;
  const optsRaw = Array.isArray(o.options) ? o.options : [];
  const options = optsRaw.map(parseOption).filter((x): x is PendingAskOption => x != null);
  if (options.length === 0) return null;
  const q: PendingAskQuestion = { id, prompt, options };
  if (o.allow_multiple === true) q.allow_multiple = true;
  return q;
}

export function parsePendingAsk(raw: unknown): PendingAsk | null {
  if (raw == null || raw === "") return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const request_id = asTrimmedString(o.request_id);
  if (!request_id) return null;
  const qsRaw = Array.isArray(o.questions) ? o.questions : [];
  const questions = qsRaw.map(parseQuestion).filter((x): x is PendingAskQuestion => x != null);
  if (questions.length === 0) return null;
  const via = o.detect_via;
  const detect_via: PendingAsk["detect_via"] = via === "jsonl" || via === "hook" || via === "cdp" ? via : "cdp";
  const detected_at = typeof o.detected_at === "number" && Number.isFinite(o.detected_at) ? o.detected_at : Date.now();
  const next: PendingAsk = { request_id, questions, detected_at, detect_via };
  if (o.kind === "plan") next.kind = "plan";
  const filename = asTrimmedString(o.filename);
  if (filename) next.filename = filename;
  const conversation_id = asTrimmedString(o.conversation_id);
  if (conversation_id) next.conversation_id = conversation_id;
  return next;
}

/** 多题被收成一题时，字母 id 会重复（每题都有 a）。这种列表不能当单选。 */
export function optionIdsCollide(options: { id: string }[]): boolean {
  const seen = new Set<string>();
  for (const o of options) {
    const id = o.id.trim();
    if (!id) continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

export function continueAllowed(ask: PendingAsk): boolean {
  if (!ask.questions.length) return false;
  return ask.questions.every((q) => q.allow_multiple !== true && !optionIdsCollide(q.options));
}

/** Chips the operator can pick. Other/freeform is a textarea, not a letter row. */
export function choiceOptions(ask: PendingAsk): PendingAskOption[] {
  return (ask.questions[0]?.options ?? []).filter((o) => o.freeform !== true);
}

export const ASK_TEXT_MAX = 4000;

export function mergePendingAskRecord(existing: PendingAsk | null, incoming: PendingAsk): PendingAsk {
  if (!existing || existing.request_id !== incoming.request_id) return incoming;
  const takeQuestions = isPlanAsk(incoming) && incoming.detected_at >= existing.detected_at;
  return {
    ...existing,
    questions: takeQuestions ? incoming.questions : existing.questions,
    detected_at: takeQuestions ? incoming.detected_at : existing.detected_at,
    filename: incoming.filename ?? existing.filename,
    detect_via: existing.detect_via === "jsonl" && incoming.detect_via !== "jsonl"
      ? incoming.detect_via
      : existing.detect_via,
  };
}

export function optionInAsk(ask: PendingAsk, questionId: string, optionId: string): boolean {
  const q = ask.questions.find((x) => x.id === questionId)
    ?? (ask.questions.length === 1 ? ask.questions[0] : undefined);
  if (!q) return false;
  return q.options.some((o) => o.freeform !== true && o.id === optionId);
}
