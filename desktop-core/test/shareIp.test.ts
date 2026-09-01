import { describe, expect, test } from "bun:test";
import { isDeniedIface, isRfc1918, pickShareCandidates } from "../src/shareIp";

test("rfc1918 yes/no", () => {
  expect(isRfc1918("10.0.0.1")).toBe(true);
  expect(isRfc1918("172.16.0.1")).toBe(true);
  expect(isRfc1918("172.31.255.1")).toBe(true);
  expect(isRfc1918("192.168.1.1")).toBe(true);
  expect(isRfc1918("172.15.0.1")).toBe(false);
  expect(isRfc1918("8.8.8.8")).toBe(false);
  expect(isRfc1918("100.64.0.1")).toBe(false);
  expect(isRfc1918("127.0.0.1")).toBe(false);
});

test("denies utun docker veth br vmnet tailscale wg", () => {
  for (const n of ["utun2", "UTUN0", "docker0", "veth1", "br0", "bridge0", "vmnet8", "vnic0", "tailscale0", "wg0", "tun0", "ppp0"]) {
    expect(isDeniedIface(n)).toBe(true);
  }
  expect(isDeniedIface("en0")).toBe(false);
  expect(isDeniedIface("eth0")).toBe(false);
});

test("pickShareCandidates drops docker 172.17 even though rfc1918", () => {
  const rows = pickShareCandidates([
    { name: "docker0", ipv4: "172.17.0.1" },
    { name: "en0", ipv4: "192.168.1.23" },
    { name: "utun4", ipv4: "10.8.0.2" },
  ]);
  expect(rows.map((r) => r.ipv4)).toEqual(["192.168.1.23"]);
  expect(rows[0].maybeUnreachable).toBe(false);
});

test("marks non en/eth as maybeUnreachable", () => {
  const rows = pickShareCandidates([{ name: "wlan0", ipv4: "192.168.0.5" }]);
  expect(rows[0]?.maybeUnreachable).toBe(true);
});

test("zero rfc1918 candidates after deny/loopback/public", () => {
  expect(
    pickShareCandidates([
      { name: "lo0", ipv4: "127.0.0.1" },
      { name: "docker0", ipv4: "172.17.0.1" },
      { name: "en0", ipv4: "8.8.8.8" },
    ]),
  ).toEqual([]);
});
