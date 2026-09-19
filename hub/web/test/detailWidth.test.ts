import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RATIO, MAX_RATIO, MIN_PX, parseStoredWidth, pxFromRatio, ratioFromPx,
} from "../src/detailWidth";

describe("detail drawer width is a viewport ratio", () => {
  test("legacy pixel prefs convert against the current window so they still fit", () => {
    expect(parseStoredWidth(900, 1100).px).toBeLessThanOrEqual(Math.floor(1100 * MAX_RATIO));
    expect(parseStoredWidth(900, 1100).px).toBeGreaterThanOrEqual(MIN_PX);
    const large = parseStoredWidth(900, 1100);
    const moved = pxFromRatio(large.ratio, 2560);
    expect(moved).toBeGreaterThan(900);
    expect(moved).toBe(pxFromRatio(900 / 1100, 2560));
  });

  test("a 900px drawer from a big monitor shrinks onto a laptop instead of overflowing", () => {
    const stored = parseStoredWidth(1200, 2560);
    const laptop = pxFromRatio(stored.ratio, 1100);
    expect(laptop).toBeLessThanOrEqual(Math.floor(1100 * MAX_RATIO));
    expect(laptop).toBeLessThan(1200);
  });

  test("ratios persist; pixels >= 2 are treated as legacy", () => {
    expect(parseStoredWidth(0.4, 1440).ratio).toBeCloseTo(DEFAULT_RATIO, 5);
    expect(parseStoredWidth(0.4, 1440).px).toBe(pxFromRatio(0.4, 1440));
    expect(parseStoredWidth(576, 1440).ratio).toBeCloseTo(576 / 1440, 5);
    expect(ratioFromPx(576, 1440)).toBeCloseTo(0.4, 5);
  });

  test("missing or junk storage falls back to the default ratio", () => {
    expect(parseStoredWidth(null, 1440).ratio).toBe(DEFAULT_RATIO);
    expect(parseStoredWidth("nope", 800).ratio).toBe(DEFAULT_RATIO);
    expect(parseStoredWidth(-10, 1440).ratio).toBe(DEFAULT_RATIO);
  });
});
