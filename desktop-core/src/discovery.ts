import { formatJoinUri } from "./joinUri";

export const MDNS_SERVICE_TYPE = "_armada._tcp.local.";
export const MDNS_TXT_VER = "1";

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

export type DiscoveredFleet = {
  name: string;
  ipv4: string;
  port: number;
  token: string;
};

export function defaultDiscoverable(): boolean {
  return true;
}

export function parseDiscoveryTxt(
  txt: Record<string, string>,
  name: string,
  port: number,
): DiscoveredFleet | { error: "incomplete" } {
  const ipv4 = txt.ip?.trim() ?? "";
  const token = txt.token?.trim() ?? "";
  const ver = txt.ver?.trim() ?? "";
  if (!ipv4 || !IPV4.test(ipv4) || !token || ver !== MDNS_TXT_VER) {
    return { error: "incomplete" };
  }
  return {
    name,
    ipv4,
    port: port > 0 ? port : 7380,
    token,
  };
}

export function discoveryJoinUri(fleet: DiscoveredFleet): string {
  return formatJoinUri(`${fleet.ipv4}:${fleet.port}`, fleet.token);
}

export function shouldHideOwnFleet(advertisedIp: string, localIps: string[]): boolean {
  return localIps.includes(advertisedIp);
}

export function discoveredRowView(fleet: Pick<DiscoveredFleet, "name" | "ipv4" | "port">): { title: string; subtitle: string } {
  return { title: fleet.name, subtitle: `${fleet.ipv4}:${fleet.port}` };
}

export function advertiseFailedCopy(): string {
  return "开放广播失败，请用分享链接邀请";
}

export function noOpenFleetsCopy(): string {
  return "未发现开放舰队，可粘贴链接加入";
}
