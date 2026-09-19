export type AskOptionRow = { id: string; label: string; text: string; freeform?: boolean };

/** Letter is shown once; strip "A：" / "A " prefixes so the row is not "A A…". */
export function askOptionDisplayText(label: string, text: string): string {
  const L = label.trim();
  const t = text.trim();
  if (!t || t === L) return "";
  if (!L) return t;
  const escaped = L.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = t.replace(new RegExp(`^${escaped}(?:\\s*[：:]\\s*|\\s+)`), "").trim();
  return stripped;
}

/** Cursor Ask: A/B/C plus a D Other row. Synthesize Other when CDP omitted the freeform letter. */
export function visibleAskOptions(options: AskOptionRow[]): AskOptionRow[] {
  if (options.some((o) => o.freeform === true)) return options;
  const used = new Set(options.map((o) => o.label.trim().toUpperCase()).filter(Boolean));
  let letter = "D";
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(65 + i);
    if (!used.has(c)) {
      letter = c;
      break;
    }
  }
  return [...options, { id: "__freeform__", label: letter, text: "Other...", freeform: true }];
}

export function isFreeformAskOption(options: AskOptionRow[], picked: string): boolean {
  const hit = options.find((o) => o.id === picked);
  return hit?.freeform === true || picked === "__freeform__";
}
