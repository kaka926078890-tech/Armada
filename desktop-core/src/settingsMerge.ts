export function mergeArmadaSettings(raw: string, hubUrl: string, token: string): { json: string; changed: boolean } {
  let obj: Record<string, unknown> = {};
  const t = raw.trim();
  if (t) obj = JSON.parse(t) as Record<string, unknown>;
  const next = { ...obj, "armada.hubUrl": hubUrl, "armada.token": token };
  const changed = obj["armada.hubUrl"] !== hubUrl || obj["armada.token"] !== token;
  return { json: `${JSON.stringify(next, null, 2)}\n`, changed };
}
