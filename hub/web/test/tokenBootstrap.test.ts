import { describe, expect, test } from "bun:test";
import { consumeQueryToken, isDesktopShell, searchWithoutToken } from "../src/tokenBootstrap";

test("prefers query token and asks to strip", () => {
  expect(consumeQueryToken("?token=abc&x=1", "")).toEqual({ token: "abc", stripQuery: true });
  expect(consumeQueryToken("token=abc", "old")).toEqual({ token: "abc", stripQuery: true });
});

test("keeps localStorage when no query", () => {
  expect(consumeQueryToken("", "stored")).toEqual({ token: "stored", stripQuery: false });
  expect(consumeQueryToken("?foo=1", "")).toEqual({ token: "", stripQuery: false });
});

test("strips token but keeps desktop=1 so the shell actions stay on", () => {
  expect(searchWithoutToken("?token=abc&desktop=1")).toBe("?desktop=1");
  expect(isDesktopShell("?token=abc&desktop=1")).toBe(true);
  expect(isDesktopShell("?desktop=1")).toBe(true);
  expect(isDesktopShell("")).toBe(false);
});
