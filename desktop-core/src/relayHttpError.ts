export const NETWORK_INTERCEPT_COPY =
  "当前网络拦截了中转。请关掉 Wi‑Fi 改用蜂窝，或换一个网络后再打开。";

export const PAIR_INVITE_COPY = "这是中台链接，请粘贴 App 邀请（armada-relay://op）";

export function operatorCopy(code: string): string {
  switch (code) {
    case "OPERATOR_REQUIRED": return PAIR_INVITE_COPY;
    case "HUB_OFFLINE": return "中台离线";
    case "HUB_TIMEOUT": return "中台处理超时，请再发一次";
    case "RATE_LIMIT": return "点得太快，请稍后再发";
    case "EMPTY_PROMPT": return "提示词是空的";
    case "NET_INTERCEPT": return NETWORK_INTERCEPT_COPY;
    case "ASK_INVALID_OPTION": return "选项无效，请改选或 Skip";
    case "ASK_TEXT_EMPTY": return "先写回复，或不选选项去点上面的答案";
    case "ASK_TEXT_TOO_LONG": return "回复太长，请缩短后再发";
    case "ASK_IN_FLIGHT": return "正在提交，请稍候";
    case "NO_PENDING_ASK": return "当前没有待回答的问题";
    case "ASK_MISMATCH": return "问题已更新，请刷新后再答";
    case "NO_ASSISTANT_BODY": return "任务已完成，正文尚未生成";
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
  if (status === 403) {
    return { code: "NET_INTERCEPT", message: NETWORK_INTERCEPT_COPY };
  }
  return { code: `HTTP_${status}`, message: `HTTP ${status}` };
}
