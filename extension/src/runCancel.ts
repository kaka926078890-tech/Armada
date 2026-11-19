/** Cancel only blocks the inject that was in flight. The same card can run again. */
export function noteRunReopened(cancelled: Set<string>, runId: string): void {
  if (runId) cancelled.delete(runId);
}
