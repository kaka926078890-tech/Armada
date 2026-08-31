export interface Machine {
  id: string; name: string; os: string;
  cursor_version: string | null; extension_version: string | null;
  open_workspaces: string; status: string; last_seen_at: number | null;
  display_name?: string | null;
}
export interface RunEvent {
  id: number; run_id: string; seq: number; source: string;
  hook_event_name: string | null; payload: string; ts: number; post_terminal: number;
}
export type { RunRow } from "./boardState";
