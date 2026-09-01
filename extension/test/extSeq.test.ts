import { describe, expect, test } from "bun:test";
import { createExtSeq } from "../src/extSeq";

describe("createExtSeq", () => {
  test("does not restart in the 1e9 band that older Windows sessions already used", () => {
    const next = createExtSeq(() => 1_788_244_789_853);
    const a = next();
    const b = next();
    expect(a).toBeGreaterThan(1_000_000_082);
    expect(b).toBe(a + 1);
  });

  test("two reloads seconds apart do not reuse seqs", () => {
    const first = createExtSeq(() => 1_000);
    const a = first();
    const second = createExtSeq(() => 2_000);
    expect(second()).toBeGreaterThan(a);
  });
});
