import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  ASK_CONTINUE_BTN, ASK_PLAN_BTN, ASK_SKIP_BTN, UI_BTN, UI_CHIP, UI_OPTION,
} from "../src/ui";

const srcRoot = join(import.meta.dir, "../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

describe("hub UI density is one scale", () => {
  test("shared tokens: chrome 32px, chips 28px, options same as chrome", () => {
    expect(UI_BTN).toContain("h-8");
    expect(UI_BTN).toContain("text-[13px]");
    expect(UI_CHIP).toContain("h-7");
    expect(UI_OPTION).toContain("min-h-8");
    expect(UI_OPTION).not.toContain("min-h-11");
    expect(ASK_CONTINUE_BTN).toContain("h-8");
    expect(ASK_PLAN_BTN).toContain("h-8");
    expect(ASK_SKIP_BTN).toContain("h-8");
    expect(ASK_CONTINUE_BTN).not.toContain("min-h-9");
    expect(ASK_CONTINUE_BTN).not.toContain("min-w-[128px]");
  });

  test("pages do not mix oversized Ask rows or 10px chrome", () => {
    const files = walk(srcRoot).filter((p) => !p.endsWith("/ui.ts"));
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (text.includes("min-h-11")) hits.push(`${file}: min-h-11`);
      if (text.includes("min-w-[128px]")) hits.push(`${file}: min-w-[128px]`);
      if (text.includes("text-[10px]")) hits.push(`${file}: text-[10px]`);
      if (text.includes("controlSize(.large)") || text.includes("min-h-11")) hits.push(`${file}: large control`);
    }
    expect(hits).toEqual([]);
  });
});
