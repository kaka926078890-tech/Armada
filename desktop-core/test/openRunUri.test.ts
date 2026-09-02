import { describe, expect, test } from "bun:test";
import { firstArmadaJoinUri } from "../src/shellUi";
import {
  firstArmadaOpenRun,
  formatOpenRunUri,
  parseOpenRunUri,
} from "../src/openRunUri";

const payload = {
  runId: "r-1",
  machineId: "win-desktop",
  workspaceRoot: String.raw`C:\Users\op\proj`,
};

describe("parseOpenRunUri", () => {
  test("round-trips Windows workspace root", () => {
    const uri = formatOpenRunUri(payload);
    expect(uri.startsWith("armada://open-run?")).toBe(true);
    expect(uri.includes("token")).toBe(false);
    expect(parseOpenRunUri(uri)).toEqual(payload);
  });

  test("accepts trailing slash on path", () => {
    expect(parseOpenRunUri("armada://open-run/?runId=r-1&machineId=m-1&root=/tmp/a")).toEqual({
      runId: "r-1",
      machineId: "m-1",
      workspaceRoot: "/tmp/a",
    });
  });

  test("incomplete without any of the three fields", () => {
    expect(parseOpenRunUri("armada://open-run?runId=r-1&machineId=m-1")).toEqual({ error: "incomplete" });
    expect(parseOpenRunUri("armada://open-run?runId=r-1&root=/tmp")).toEqual({ error: "incomplete" });
    expect(parseOpenRunUri("armada://open-run?machineId=m-1&root=/tmp")).toEqual({ error: "incomplete" });
  });

  test("rejects join and non-armada urls", () => {
    expect(parseOpenRunUri("armada://join?hub=1.2.3.4:7380&token=ab")).toEqual({ error: "invalid" });
    expect(parseOpenRunUri("https://open-run?runId=r-1&machineId=m-1&root=/tmp")).toEqual({
      error: "invalid",
    });
  });
});

describe("firstArmadaOpenRun / firstArmadaJoinUri", () => {
  test("open-run is not treated as a join uri", () => {
    const uri = formatOpenRunUri(payload);
    expect(firstArmadaJoinUri([uri])).toBeNull();
    expect(firstArmadaJoinUri(["https://example", uri, "armada://join?hub=10.0.0.2:7380&token=" + "a".repeat(64)])).toMatch(
      /^armada:\/\/join\?/,
    );
    expect(firstArmadaOpenRun(["https://example", uri])).toEqual(payload);
    expect(firstArmadaJoinUri(["armada://join?hub=10.0.0.2:7380"])).toBe(
      "armada://join?hub=10.0.0.2:7380",
    );
  });
});
