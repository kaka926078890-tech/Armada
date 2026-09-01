import { describe, expect, test } from "bun:test";
import { formatJoinUri, parseJoinUri } from "../src/joinUri";

const token = "a".repeat(64);

describe("parseJoinUri", () => {
  test("parses join and /join with hub and token", () => {
    const a = parseJoinUri(`armada://join?hub=192.168.1.23:7380&token=${token}`);
    const b = parseJoinUri(`armada://join/?hub=192.168.1.23:7380&token=${token}`);
    expect(a).toEqual({ hubHost: "192.168.1.23", hubPort: 7380, token, hubHostPort: "192.168.1.23:7380" });
    expect(b).toMatchObject({ hubHost: "192.168.1.23", hubPort: 7380, token });
  });

  test("strips http:// on hub and defaults port 7380", () => {
    const r = parseJoinUri(`armada://join?hub=http://10.0.0.2&token=${token}`);
    expect(r).toMatchObject({ hubHost: "10.0.0.2", hubPort: 7380, hubHostPort: "10.0.0.2:7380" });
  });

  test("incomplete without token or hub", () => {
    expect(parseJoinUri("armada://join?hub=1.2.3.4:7380")).toEqual({ error: "incomplete" });
    expect(parseJoinUri(`armada://join?token=${token}`)).toEqual({ error: "incomplete" });
  });

  test("rejects non-armada scheme", () => {
    expect(parseJoinUri(`https://join?hub=1.2.3.4:7380&token=${token}`)).toEqual({ error: "invalid" });
  });
});

describe("formatJoinUri", () => {
  test("round-trips", () => {
    const s = formatJoinUri("192.168.1.23:7380", token);
    expect(s).toBe(`armada://join?hub=192.168.1.23:7380&token=${token}`);
    expect(parseJoinUri(s)).toMatchObject({ hubHostPort: "192.168.1.23:7380", token });
  });
});
