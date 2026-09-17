import { describe, expect, test } from "bun:test";
import { keepAwakeArgs } from "../src/lifecycle";

test("owned hub holds idle and system sleep for the bun pid", () => {
  expect(keepAwakeArgs(39523)).toEqual(["-i", "-s", "-w", "39523"]);
});
