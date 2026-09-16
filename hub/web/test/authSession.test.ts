import { describe, expect, test } from "bun:test";
import { decideAuthLoss } from "../src/authSession";

describe("decideAuthLoss", () => {
  test("desktop asks the host to re-inject the token instead of logging out", () => {
    expect(decideAuthLoss(true)).toBe("ask-host");
  });

  test("browser 401 still logs out to the pairing form", () => {
    expect(decideAuthLoss(false)).toBe("logout");
  });
});
