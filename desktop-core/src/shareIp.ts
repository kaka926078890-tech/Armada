const DENY = ["utun", "tun", "ppp", "docker", "veth", "br", "bridge", "vmnet", "vnic", "tailscale", "wg"];

export function isRfc1918(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function isDeniedIface(name: string): boolean {
  const n = name.toLowerCase();
  return DENY.some((p) => n === p || n.startsWith(p));
}

export function pickShareCandidates(ifaces: { name: string; ipv4: string }[]): { ipv4: string; name: string; maybeUnreachable: boolean }[] {
  const out = [];
  for (const it of ifaces) {
    if (isDeniedIface(it.name)) continue;
    if (it.ipv4.startsWith("127.") || it.ipv4.startsWith("169.254.")) continue;
    if (!isRfc1918(it.ipv4)) continue;
    const low = it.name.toLowerCase();
    const maybeUnreachable = !(low.startsWith("en") || low.startsWith("eth"));
    out.push({ ipv4: it.ipv4, name: it.name, maybeUnreachable });
  }
  out.sort((a, b) => Number(a.maybeUnreachable) - Number(b.maybeUnreachable) || a.name.localeCompare(b.name));
  return out;
}
