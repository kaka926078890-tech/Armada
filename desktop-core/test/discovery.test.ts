import { describe, expect, test } from "bun:test";
import { formatJoinUri } from "../src/joinUri";
import {
  MDNS_SERVICE_TYPE,
  MDNS_TXT_VER,
  advertiseFailedCopy,
  defaultDiscoverable,
  discoveredRowView,
  discoveryJoinUri,
  noOpenFleetsCopy,
  parseDiscoveryTxt,
  shouldHideOwnFleet,
} from "../src/discovery";

const ticket = `jt_${"b".repeat(64)}`;
const longLived = "c".repeat(64);

describe("defaults and copy", () => {
  test("create is discoverable by default", () => {
    expect(defaultDiscoverable()).toBe(true);
  });

  test("service type is armada tcp local", () => {
    expect(MDNS_SERVICE_TYPE).toBe("_armada._tcp.local.");
    expect(MDNS_TXT_VER).toBe("2");
  });

  test("empty-list and advertise-failed copy do not include credentials", () => {
    expect(noOpenFleetsCopy()).toMatch(/未发现开放舰队/);
    expect(noOpenFleetsCopy()).toMatch(/粘贴/);
    expect(advertiseFailedCopy()).toMatch(/分享链接/);
    expect(noOpenFleetsCopy().includes(ticket)).toBe(false);
    expect(advertiseFailedCopy().toLowerCase().includes("token")).toBe(false);
  });
});

describe("parseDiscoveryTxt", () => {
  test("builds a fleet from ip ticket ver=2 and srv port", () => {
    const fleet = parseDiscoveryTxt(
      { ip: "192.168.1.23", ticket, ver: "2" },
      "Studio",
      7380,
    );
    expect(fleet).toEqual({
      name: "Studio",
      ipv4: "192.168.1.23",
      port: 7380,
      ticket,
    });
  });

  test("zero srv port falls back to 7380", () => {
    const fleet = parseDiscoveryTxt(
      { ip: "10.0.0.2", ticket, ver: "2" },
      "WinBox",
      0,
    );
    expect("error" in fleet).toBe(false);
    if ("error" in fleet) return;
    expect(fleet.port).toBe(7380);
  });

  test("drops long-lived token TXT and incomplete records", () => {
    expect(parseDiscoveryTxt({ ticket, ver: "2" }, "A", 7380)).toEqual({ error: "incomplete" });
    expect(parseDiscoveryTxt({ ip: "192.168.1.23", ver: "2" }, "A", 7380)).toEqual({ error: "incomplete" });
    expect(parseDiscoveryTxt({ ip: "192.168.1.23", token: longLived, ver: "1" }, "A", 7380)).toEqual({ error: "incomplete" });
    expect(parseDiscoveryTxt({ ip: "192.168.1.23", ticket, ver: "1" }, "A", 7380)).toEqual({ error: "incomplete" });
    expect(parseDiscoveryTxt({ ip: "not-an-ip", ticket, ver: "2" }, "A", 7380)).toEqual({ error: "incomplete" });
    expect(parseDiscoveryTxt({ ip: "192.168.1.23", ticket: longLived, ver: "2" }, "A", 7380)).toEqual({ error: "incomplete" });
  });
});

describe("discoveryJoinUri and row view", () => {
  test("join uri carries ticket and row omits it", () => {
    const fleet = {
      name: "Studio",
      ipv4: "192.168.1.23",
      port: 7380,
      ticket,
    };
    expect(discoveryJoinUri(fleet)).toBe(formatJoinUri("192.168.1.23:7380", ticket));
    const row = discoveredRowView(fleet);
    expect(row.title).toBe("Studio");
    expect(row.subtitle).toBe("192.168.1.23:7380");
    expect(row.subtitle.includes(ticket)).toBe(false);
    expect(JSON.stringify(row).includes(ticket)).toBe(false);
  });
});

describe("shouldHideOwnFleet", () => {
  test("hides when advertised ip is a local share candidate", () => {
    expect(shouldHideOwnFleet("192.168.1.23", ["10.0.0.1", "192.168.1.23"])).toBe(true);
    expect(shouldHideOwnFleet("192.168.1.23", ["10.0.0.1"])).toBe(false);
  });
});
