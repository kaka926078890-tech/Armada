import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyRelayHttp, NETWORK_INTERCEPT_COPY, PAIR_INVITE_COPY, operatorCopy } from "../src/relayHttpError";

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

  test("HTML 500 from uuWAF is not the Wi-Fi intercept copy", () => {
    const r = classifyRelayHttp(500, "<html><center>uuWAF</center></html>");
    expect(r.code).toBe("HTTP_500");
    expect(r.message).toBe("HTTP 500");
    expect(r.code).not.toBe("NET_INTERCEPT");
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

  test("ASK_* and NO_ASSISTANT_BODY have Chinese operator copy", () => {
    expect(operatorCopy("ASK_INVALID_OPTION")).toBe("选项无效，请改选或 Skip");
    expect(operatorCopy("ASK_IN_FLIGHT")).toBe("正在提交，请稍候");
    expect(operatorCopy("NO_PENDING_ASK")).toBe("当前没有待回答的问题");
    expect(operatorCopy("ASK_MISMATCH")).toBe("问题已更新，请刷新后再答");
    expect(operatorCopy("NO_ASSISTANT_BODY")).toBe("任务已完成，正文尚未生成");
    expect(operatorCopy("ASK_TEXT_EMPTY")).toBe("先写回复，或不选选项去点上面的答案");
    expect(operatorCopy("ASK_TEXT_TOO_LONG")).toBe("回复太长，请缩短后再发");
    expect(classifyRelayHttp(409, '{"error":"ASK_INVALID_OPTION"}').message).toBe("选项无效，请改选或 Skip");
  });

  test("iOS and Android operatorMessage cover the same ASK_* codes", () => {
    const root = join(import.meta.dir, "../..");
    const swift = readFileSync(join(root, "mobile/ios/ArmadaRemote/RelayAPI.swift"), "utf8");
    const kt = readFileSync(join(root, "mobile/android/core/src/main/kotlin/app/armada/remote/OperatorMessages.kt"), "utf8");
    for (const code of [
      "ASK_INVALID_OPTION", "ASK_IN_FLIGHT", "NO_PENDING_ASK", "ASK_MISMATCH", "NO_ASSISTANT_BODY",
      "ASK_TEXT_EMPTY", "ASK_TEXT_TOO_LONG",
      "FILE_NOT_FOUND", "PATH_OUTSIDE_WORKSPACE", "FILE_TOO_LARGE", "FILE_NOT_TEXT",
      "FILE_READ_TIMEOUT", "FILE_VIEW_UNSUPPORTED",
    ]) {
      expect(swift).toContain(`case "${code}"`);
      expect(kt).toContain(`"${code}"`);
      expect(operatorCopy(code)).not.toBe(code);
    }
  });

  test("iOS and Android send JSON blob chunks and only treat 403 as Wi-Fi intercept", () => {
    const root = join(import.meta.dir, "../..");
    const swift = readFileSync(join(root, "mobile/ios/ArmadaRemote/RelayAPI.swift"), "utf8");
    const client = readFileSync(join(root, "mobile/android/app/src/main/java/app/armada/remote/RelayClient.kt"), "utf8");
    const messages = readFileSync(join(root, "mobile/android/core/src/main/kotlin/app/armada/remote/OperatorMessages.kt"), "utf8");
    const waf = readFileSync(join(root, "mobile/android/core/src/main/kotlin/app/armada/remote/WafJson.kt"), "utf8");
    expect(swift).toContain("wafJsonChunkBytes = 6 * 1024");
    expect(swift).toContain("sendPromptChunks");
    expect(swift).toContain("application/json");
    expect(swift).not.toContain("multipart/form-data");
    expect(waf).toContain("WAF_JSON_CHUNK_BYTES = 6 * 1024");
    expect(client).toContain("BLOB_CHUNK = WAF_JSON_CHUNK_BYTES");
    expect(client).toContain("sendPromptChunks");
    expect(messages).toContain("if (status == 403) return \"NET_INTERCEPT\"");
    expect(swift).toContain("if status == 403");
    expect(swift).not.toContain("<html>");
  });
});
