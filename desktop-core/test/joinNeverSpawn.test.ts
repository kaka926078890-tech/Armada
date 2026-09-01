import { expect, test } from "bun:test";
import { joinMaySpawnHub } from "../src/lifecycle";

test("join path does not use spawn decision", () => {
  expect(joinMaySpawnHub()).toBe(false);
});
