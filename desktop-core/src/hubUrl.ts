export type HubTargetInput = {
  role: "create" | "join";
  parsedHost: string;
  parsedPort: number;
  localShareCandidates: string[];
  existingHubUrl: string | null;
};

export type HubTarget = {
  cursorHubUrl: string;
  webviewOrigin: string;
  joinSelf: boolean;
  overwriteCursorHubUrl: boolean;
};

export function resolveHubTargets(i: HubTargetInput): HubTarget {
  const joinSelf = i.role === "join" && i.parsedPort === 7380 && i.localShareCandidates.includes(i.parsedHost);
  if (i.role === "create" || joinSelf) {
    const existing = i.existingHubUrl?.replace(/^https?:\/\//, "").replace(/\/+$/, "") ?? null;
    const overwrite = existing !== "127.0.0.1:7380";
    return {
      cursorHubUrl: "127.0.0.1:7380",
      webviewOrigin: "127.0.0.1:7380",
      joinSelf,
      overwriteCursorHubUrl: overwrite,
    };
  }
  const hub = `${i.parsedHost}:${i.parsedPort}`;
  return { cursorHubUrl: hub, webviewOrigin: hub, joinSelf: false, overwriteCursorHubUrl: true };
}
