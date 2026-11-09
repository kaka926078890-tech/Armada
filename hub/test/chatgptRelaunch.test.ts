import { describe, expect, test } from "bun:test";
import { afterQuit } from "../src/chatgptCdp";

describe("chatgpt relaunch", () => {
  test("does not open while the main process is still running", () => {
    expect(afterQuit(true)).toBe("stuck");
    expect(afterQuit(false)).toBe("open");
  });
});
