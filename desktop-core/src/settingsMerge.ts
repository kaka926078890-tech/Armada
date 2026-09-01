export function mergeArmadaSettings(raw: string, hubUrl: string, token: string): { json: string; changed: boolean } {
  let obj: Record<string, unknown> = {};
  const t = raw.trim();
  if (t) obj = JSON.parse(t) as Record<string, unknown>;
  const next = { ...obj, "armada.hubUrl": hubUrl, "armada.token": token };
  const changed = obj["armada.hubUrl"] !== hubUrl || obj["armada.token"] !== token;
  return { json: `${JSON.stringify(next, null, 2)}\n`, changed };
}

/** Skip the settings.json write when join-self no-op and both keys already match. Token rotation still writes. */
export function shouldWriteCursorSettings(opts: {
  overwriteCursorHubUrl: boolean;
  existingHubUrl: unknown;
  existingToken: unknown;
  hubUrl: string;
  token: string;
}): boolean {
  const hubToWrite = opts.overwriteCursorHubUrl
    ? opts.hubUrl
    : (typeof opts.existingHubUrl === "string" ? opts.existingHubUrl : opts.hubUrl);
  return opts.existingHubUrl !== hubToWrite || opts.existingToken !== opts.token;
}
