import { describe, expect, test } from "bun:test";
import { classifyRelayHttp, NETWORK_INTERCEPT_COPY, PAIR_INVITE_COPY } from "../src/relayHttpError";

describe("classifyRelayHttp", () => {
  test("JSON 403 OPERATOR_REQUIRED is the pair-invite copy, not HTTP 403", () => {
    const r = classifyRelayHttp(403, '{"error":"OPERATOR_REQUIRED"}');
    expect(r.code).toBe("OPERATOR_REQUIRED");
    expect(r.message).toBe(PAIR_INVITE_COPY);
    expect(r.message).not.toMatch(/HTTP 403/i);
  });

  test("HTML 403 from a gateway is network intercept, not raw HTTP 403", () => {
    const r = classifyRelayHttp(403, "<html><h1>403 Forbidden</h1></html>");
    expect(r.code).toBe("NET_INTERCEPT");
    expect(r.message).toBe(NETWORK_INTERCEPT_COPY);
    expect(r.message).not.toBe("HTTP 403");
  });

  test("empty 403 body is network intercept", () => {
    expect(classifyRelayHttp(403, "").code).toBe("NET_INTERCEPT");
  });

  test("JSON 503 HUB_OFFLINE stays 中台离线", () => {
    const r = classifyRelayHttp(503, '{"error":"HUB_OFFLINE"}');
    expect(r.code).toBe("HUB_OFFLINE");
    expect(r.message).toBe("中台离线");
  });

  test("JSON 502 HUB_TIMEOUT and 429 RATE_LIMIT have operator copy", () => {
    expect(classifyRelayHttp(502, '{"error":"HUB_TIMEOUT"}').message).toBe("中台处理超时，请再发一次");
    expect(classifyRelayHttp(429, '{"error":"RATE_LIMIT"}').message).toBe("点得太快，请稍后再发");
    expect(classifyRelayHttp(400, '{"error":"EMPTY_PROMPT"}').message).toBe("提示词是空的");
  });
});
