export type PendingAskOption = { id: string; label: string; text: string };

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
};

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
  return { id, label, text };
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
  return { request_id, questions, detected_at, detect_via };
}

export function continueAllowed(ask: PendingAsk): boolean {
  return ask.questions.length === 1 && ask.questions[0].allow_multiple !== true;
}

export function optionInAsk(ask: PendingAsk, questionId: string, optionId: string): boolean {
  const q = ask.questions.find((x) => x.id === questionId)
    ?? (ask.questions.length === 1 ? ask.questions[0] : undefined);
  if (!q) return false;
  return q.options.some((o) => o.id === optionId);
}
