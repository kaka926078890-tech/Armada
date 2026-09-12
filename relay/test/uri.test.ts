import { describe, expect, test } from "bun:test";
import { formatOpUri, formatPairUri, parseRelayUri } from "../src/uri";

const RELAY = "https://relay.example.com";
const FLEET = "fleet-abc12";
const SECRET = "a".repeat(64);
const TOKEN = "b".repeat(64);

describe("parseRelayUri", () => {
  test("parses pair invite", () => {
    const uri = formatPairUri(RELAY, FLEET, SECRET);
    expect(parseRelayUri(uri)).toEqual({ kind: "pair", relay: RELAY, fleet: FLEET, secret: SECRET });
  });

  test("parses op invite", () => {
    const uri = formatOpUri(RELAY, FLEET, TOKEN);
    expect(parseRelayUri(uri)).toEqual({ kind: "op", relay: RELAY, fleet: FLEET, token: TOKEN });
  });

  test("rejects public http relay", () => {
    expect(parseRelayUri(`armada-relay://pair?relay=http://relay.example.com&fleet=${FLEET}&secret=${SECRET}`))
      .toEqual({ error: "insecure" });
  });

  test("allows loopback http for Simulator", () => {
    const uri = formatPairUri("http://127.0.0.1:8780", FLEET, SECRET);
    expect(parseRelayUri(uri)).toMatchObject({ kind: "pair", relay: "http://127.0.0.1:8780", fleet: FLEET });
  });

  test("rejects missing fields", () => {
    expect(parseRelayUri("armada-relay://pair?relay=https://r.example&fleet=x")).toEqual({ error: "incomplete" });
    expect(parseRelayUri(`armada-relay://op?relay=${encodeURIComponent(RELAY)}&fleet=${FLEET}`)).toEqual({ error: "incomplete" });
  });

  test("rejects wrong scheme", () => {
    expect(parseRelayUri("armada://join?hub=1.2.3.4:7380&token=ab")).toEqual({ error: "invalid" });
  });
});
