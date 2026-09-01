import { describe, expect, test } from "bun:test";
import { consumeQueryToken } from "../src/tokenBootstrap";

test("prefers query token and asks to strip", () => {
  expect(consumeQueryToken("?token=abc&x=1", "")).toEqual({ token: "abc", stripQuery: true });
  expect(consumeQueryToken("token=abc", "old")).toEqual({ token: "abc", stripQuery: true });
});

test("keeps localStorage when no query", () => {
  expect(consumeQueryToken("", "stored")).toEqual({ token: "stored", stripQuery: false });
  expect(consumeQueryToken("?foo=1", "")).toEqual({ token: "", stripQuery: false });
});
