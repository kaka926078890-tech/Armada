/** Detail drawer width is a fraction of the current viewport, not a frozen pixel width. */

export const DEFAULT_RATIO = 0.4;
export const MIN_RATIO = 0.22;
export const MAX_RATIO = 0.92;
export const MIN_PX = 400;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export function pxFromRatio(ratio: number, vw: number): number {
  if (!Number.isFinite(vw) || vw <= 0) return MIN_PX;
  const maxPx = Math.max(MIN_PX, Math.floor(vw * MAX_RATIO));
  return Math.min(maxPx, Math.max(MIN_PX, Math.round(vw * clampRatio(ratio))));
}

export function ratioFromPx(px: number, vw: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(vw) || vw <= 0) return DEFAULT_RATIO;
  return clampRatio(px / vw);
}

/** Hub / localStorage: (0, 1.5] is a ratio; >= 2 is a legacy pixel width. */
export function parseStoredWidth(raw: unknown, vw: number): { ratio: number; px: number } {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { ratio: DEFAULT_RATIO, px: pxFromRatio(DEFAULT_RATIO, vw) };
  }
  const ratio = n > 1.5 ? ratioFromPx(n, vw) : clampRatio(n);
  return { ratio, px: pxFromRatio(ratio, vw) };
}
