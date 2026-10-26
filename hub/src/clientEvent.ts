/** Strings the detail actually renders. File bodies and tool output stay in sqlite. */
const KEEP_LONG = new Set([
  "text", "prompt", "file_path", "path", "description", "error",
  "name", "tool_name", "pattern", "glob", "glob_pattern", "task", "label",
]);

const LONG = 1024;

/** Below this, GET /events returns the stored JSON unchanged. */
export const CLIENT_PAYLOAD_PASSTHROUGH = 4096;

export function slimClientPayload(value: unknown, key: string | null = null): unknown {
  if (typeof value === "string") {
    if (value.length <= LONG || (key != null && KEEP_LONG.has(key))) return value;
    return "";
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = slimClientPayload(value[i], key);
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = slimClientPayload(v, k);
    }
    return out;
  }
  return value;
}

export function clientEventPayload(payload: unknown): unknown {
  return slimClientPayload(payload ?? {});
}

export function clientEventPayloadJson(payload: string): string {
  if (payload.length <= CLIENT_PAYLOAD_PASSTHROUGH) return payload;
  try {
    return JSON.stringify(slimClientPayload(JSON.parse(payload)));
  } catch {
    return "{}";
  }
}

export function clientEventRows<T extends { payload?: unknown }>(rows: T[]): T[] {
  return rows.map((row) => {
    const payload = row.payload;
    if (typeof payload !== "string") return row;
    const next = clientEventPayloadJson(payload);
    return next === payload ? row : { ...row, payload: next };
  });
}
