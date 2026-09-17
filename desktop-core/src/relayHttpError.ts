export const NETWORK_INTERCEPT_COPY =
  "当前网络拦截了中转。请关掉 Wi‑Fi 改用蜂窝，或换一个网络后再打开。";

export const PAIR_INVITE_COPY = "这是中台链接，请粘贴 App 邀请（armada-relay://op）";

export function operatorCopy(code: string): string {
  switch (code) {
    case "OPERATOR_REQUIRED": return PAIR_INVITE_COPY;
    case "HUB_OFFLINE": return "中台离线";
    case "NET_INTERCEPT": return NETWORK_INTERCEPT_COPY;
    default: return code;
  }
}

/** Classify a relay HTTP failure. Non-JSON 403 is a gateway/Wi‑Fi intercept, not a pair/op mix-up. */
export function classifyRelayHttp(status: number, bodyText: string): { code: string; message: string } {
  const trimmed = bodyText.trim();
  try {
    const j = JSON.parse(trimmed) as { error?: unknown };
    if (typeof j?.error === "string" && j.error) {
      return { code: j.error, message: operatorCopy(j.error) };
    }
  } catch {
    /* HTML / empty / captive portal */
  }
  if (status === 403 || /<html/i.test(trimmed)) {
    return { code: "NET_INTERCEPT", message: NETWORK_INTERCEPT_COPY };
  }
  return { code: `HTTP_${status}`, message: `HTTP ${status}` };
}
