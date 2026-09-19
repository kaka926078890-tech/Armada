import { describe, expect, test } from "bun:test";
import { askOptionDisplayText, isFreeformAskOption, visibleAskOptions } from "../src/askOptions";

describe("askOptionDisplayText", () => {
  test("drops a duplicated letter so the row is not A A", () => {
    expect(askOptionDisplayText("A", "A")).toBe("");
    expect(askOptionDisplayText("A", "A：芯片只显示 A/B/C")).toBe("芯片只显示 A/B/C");
    expect(askOptionDisplayText("A", "A 甲")).toBe("甲");
    expect(askOptionDisplayText("A", "甲")).toBe("甲");
    expect(askOptionDisplayText("D", "Other...")).toBe("Other...");
  });
});

describe("visibleAskOptions", () => {
  test("keeps CDP Other as D and synthesizes D when only A/B/C arrived", () => {
    const withD = visibleAskOptions([
      { id: "a", label: "A", text: "甲" },
      { id: "d", label: "D", text: "Other...", freeform: true },
    ]);
    expect(withD.map((o) => o.id)).toEqual(["a", "d"]);
    const synthesized = visibleAskOptions([
      { id: "a", label: "A", text: "甲" },
      { id: "b", label: "B", text: "乙" },
      { id: "c", label: "C", text: "丙" },
    ]);
    expect(synthesized.at(-1)).toMatchObject({ id: "__freeform__", label: "D", text: "Other...", freeform: true });
    expect(isFreeformAskOption(synthesized, "__freeform__")).toBe(true);
    expect(isFreeformAskOption(withD, "d")).toBe(true);
    expect(isFreeformAskOption(withD, "a")).toBe(false);
  });
});
