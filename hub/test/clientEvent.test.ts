import { describe, expect, test } from "bun:test";
import { clientEventPayload, clientEventPayloadJson, slimClientPayload } from "../src/clientEvent";

describe("client event payload", () => {
  test("drops tool file bodies and keeps the path the chat summary uses", () => {
    const body = "fn main() {}\n".repeat(400);
    const slim = clientEventPayload({
      tool_name: "Write",
      tool_input: { file_path: "/ws/a/src/lib.rs", content: body },
      tool_output: body,
      generation_id: "g-1",
    }) as {
      tool_name: string;
      tool_input: { file_path: string; content: string };
      tool_output: string;
      generation_id: string;
    };
    expect(slim.tool_name).toBe("Write");
    expect(slim.tool_input.file_path).toBe("/ws/a/src/lib.rs");
    expect(slim.tool_input.content).toBe("");
    expect(slim.tool_output).toBe("");
    expect(slim.generation_id).toBe("g-1");
    expect(JSON.stringify(slim).length).toBeLessThan(500);
  });

  test("keeps assistant text and followup prompt", () => {
    const text = "结论".repeat(2000);
    const parsed = JSON.parse(clientEventPayloadJson(JSON.stringify({
      text,
      prompt: text,
      task: "查一下",
    }))) as { text: string; prompt: string; task: string };
    expect(parsed.text).toBe(text);
    expect(parsed.prompt).toBe(text);
    expect(parsed.task).toBe("查一下");
  });

  test("short stored payloads are returned unchanged", () => {
    const raw = JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "foo" } });
    expect(clientEventPayloadJson(raw)).toBe(raw);
  });

  test("oversize unparseable payloads are not forwarded", () => {
    expect(clientEventPayloadJson("x".repeat(5000))).toBe("{}");
    expect(slimClientPayload("short")).toBe("short");
  });
});
