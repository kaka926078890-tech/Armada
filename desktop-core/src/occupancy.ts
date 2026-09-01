export type OccupancyInput = {
  ownedPidAlive: boolean;
  portOpen: boolean;
  health: { ok: true; name: string } | "unreachable";
  machinesStatus: 200 | 401 | "skipped";
};

export type OccupancyDecision =
  | { action: "reuse-owned" }
  | { action: "spawn" }
  | { action: "attach" }
  | { action: "block"; reason: "foreign-armada" | "port-busy" };

export function decideOccupancy(i: OccupancyInput): OccupancyDecision {
  if (i.ownedPidAlive) return { action: "reuse-owned" };
  if (!i.portOpen) return { action: "spawn" };
  if (i.health !== "unreachable" && i.health.name === "armada-hub" && i.machinesStatus === 200) {
    return { action: "attach" };
  }
  if (i.health !== "unreachable" && i.health.name === "armada-hub" && i.machinesStatus === 401) {
    return { action: "block", reason: "foreign-armada" };
  }
  return { action: "block", reason: "port-busy" };
}
